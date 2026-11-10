import { existsSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

import type { Subprocess } from 'bun'

export type ToolResult = { code: number; stdout: string; stderr: string }
export type Tool = (argv: string[]) => Promise<ToolResult>
export type Tools = { docker: Tool | null; nixStore: Tool | null }

const LABELS = ['monica.study', 'com.docker.compose.project']
const DOCKER_STEPS = [
  { list: ['ps', '-aq'], remove: ['rm', '-f'] },
  { list: ['network', 'ls', '-q'], remove: ['network', 'rm'] },
  { list: ['volume', 'ls', '-q'], remove: ['volume', 'rm', '-f'] },
  { list: ['image', 'ls', '-q'], remove: ['image', 'rm', '-f'] },
]

const linesOf = (text: string) => [...new Set(text.split('\n').filter((line) => line !== ''))]
const reasonOf = (argv: string[], { code, stderr }: ToolResult) =>
  stderr.trim().split('\n').at(-1) || `${argv.join(' ')}: exit ${code}`

/** Playground の掃除が起こす子 process。stop() で group ごと止めるため、detached で起こして持つ。 */
export function createRunner() {
  const children = new Set<Subprocess>()
  async function run(argv: string[]): Promise<ToolResult> {
    const child = Bun.spawn(argv, {
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
    children.add(child)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { code, stdout, stderr }
    } finally {
      children.delete(child)
    }
  }
  function killAll() {
    for (const child of children) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // 既に居ない。
      }
    }
  }
  function found(name: string): Tool | null {
    const path = Bun.which(name)
    return path ? (argv) => run([path, ...argv]) : null
  }
  /** 呼ぶたびに PATH から引き、無ければ null。 */
  function tools(): Tools {
    return { docker: found('docker'), nixStore: found('nix-store') }
  }
  return { run, killAll, tools }
}

type Run = ReturnType<typeof createRunner>['run']

async function must(tool: Tool, argv: string[]): Promise<string[]> {
  const result = await tool(argv)
  if (result.code !== 0) throw new Error(reasonOf(argv, result))
  return linesOf(result.stdout)
}

async function nixRootsIn(dir: string, nixStore: Tool, run: Run): Promise<string[]> {
  const argv = ['find', dir, '-type', 'l', '-lname', '/nix/store/*']
  const found = await run(argv)
  if (found.code !== 0) throw new Error(reasonOf(argv, found))
  const roots = [
    ...new Set(
      linesOf(found.stdout).map((link) => readlinkSync(link).split('/').slice(0, 4).join('/')),
    ),
  ]
  if (roots.length === 0) return []
  const invalid = new Set(await must(nixStore, ['--check-validity', '--print-invalid', ...roots]))
  return roots.filter((root) => !invalid.has(root))
}

/** docker に届かず飛ばしたら false。 */
async function removeDocker(docker: Tool, studyId: string, failures: string[]): Promise<boolean> {
  if ((await docker(['info'])).code !== 0) return false
  for (const label of LABELS) {
    const filter = ['--filter', `label=${label}=${studyId}`]
    for (const step of DOCKER_STEPS) {
      try {
        const ids = await must(docker, [...step.list, ...filter])
        if (ids.length > 0) await must(docker, [...step.remove, ...ids])
      } catch (error) {
        failures.push((error as Error).message)
      }
    }
  }
  return true
}

// 1 つでも root から届く path を渡すと nix-store --delete は全体を断るので、死んでいて候補の外から参照されない path だけを渡す。
async function removeNixPaths(nixStore: Tool, roots: string[]) {
  const dead = new Set(await must(nixStore, ['--gc', '--print-dead']))
  const candidates = new Set(
    (await must(nixStore, ['--query', '--requisites', ...roots])).filter((path) => dead.has(path)),
  )
  if (candidates.size === 0) return
  const outside = (await must(nixStore, ['--query', '--referrers', ...candidates])).filter(
    (path) => !candidates.has(path),
  )
  if (outside.length > 0) {
    for (const path of await must(nixStore, ['--query', '--requisites', ...outside])) {
      candidates.delete(path)
    }
  }
  if (candidates.size > 0) await must(nixStore, ['--delete', ...[...candidates].toSorted()])
}

/**
 * rootsDir の nix の root を集めてから removeDir を消し、Study の docker の物と、root から届く死んだ nix の path を消す。
 * 1 つの手順が失敗しても残りを続け、理由を failures に返す。removed は removeDir があって消せたか。
 * dockerSkipped は docker が在るのに `docker info` が通らず、docker の物を消せなかったか。
 */
export async function removePlayground(
  { rootsDir, removeDir, studyId }: { rootsDir: string; removeDir: string; studyId: string },
  { tools, run }: { tools: Tools; run: Run },
): Promise<{ removed: boolean; failures: string[]; dockerSkipped: boolean }> {
  const failures: string[] = []
  let roots: string[] = []
  if (tools.nixStore && existsSync(rootsDir)) {
    try {
      roots = await nixRootsIn(rootsDir, tools.nixStore, run)
    } catch (error) {
      failures.push((error as Error).message)
    }
  }
  let removed = false
  let rmFailed = false
  if (existsSync(removeDir)) {
    const argv = ['rm', '-rf', removeDir]
    const result = await run(argv)
    if (result.code === 0) removed = true
    else {
      rmFailed = true
      failures.push(reasonOf(argv, result))
    }
  }
  const dockerSkipped = tools.docker
    ? !(await removeDocker(tools.docker, studyId, failures))
    : false
  // root が消えずに残っているので、消そうとしても nix は断る。
  if (tools.nixStore && roots.length > 0 && !rmFailed) {
    try {
      await removeNixPaths(tools.nixStore, roots)
    } catch (error) {
      failures.push((error as Error).message)
    }
  }
  return { removed, failures, dockerSkipped }
}

/** .git を持つ Prototype ごとに、.gitignore が無視する物だけを消す。 */
export async function cleanPrototypes(studyDir: string, run: Run): Promise<string[]> {
  const prototypes = join(studyDir, 'prototypes')
  if (!existsSync(prototypes)) return []
  const failures: string[] = []
  for (const entry of readdirSync(prototypes, { withFileTypes: true })) {
    const dir = join(prototypes, entry.name)
    // .git の無い dir で git -C を呼ぶと、親の dir の repo を拾う。
    if (!entry.isDirectory() || !existsSync(join(dir, '.git'))) continue
    const argv = ['git', '-C', dir, 'clean', '-fdX']
    const result = await run(argv)
    if (result.code !== 0) failures.push(reasonOf(argv, result))
  }
  return failures
}
