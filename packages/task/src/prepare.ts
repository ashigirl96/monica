import { appendFileSync, closeSync, existsSync, openSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { inheritableEnv } from '@tania/workbench/server'
import type { Subprocess } from 'bun'

import { oneLine } from './github.ts'
import type { IssueRef } from './ref.ts'
import type { bench } from './schema.ts'

const SETUP_TIMEOUT_MS = 600_000
const SETUP_KILL_GRACE_MS = 2000
const SETUP_SCRIPT = '.tania/setup.sh'

export type Ghq = {
  root(): Promise<string>
  get(repo: string): Promise<void>
}

export const defaultGhq: Ghq = {
  root: () => command(['ghq', 'root'], 'ghq root'),
  async get(repo) {
    await command(['ghq', 'get', repo], 'ghq get')
  },
}

export const branchOf = ({ number }: IssueRef) => `issue-${number}`

export const worktreeOf = (home: string, ref: IssueRef) =>
  join(home, 'worktrees', ref.repo, branchOf(ref))

// worktree の中に書くと、worktree に untracked file が残る。
export const setupLogOf = (home: string, ref: IssueRef) =>
  join(home, 'logs/setup', ref.repo, `${branchOf(ref)}.log`)

export const checkoutUnder = (ghqRoot: string, repo: string) => join(ghqRoot, 'github.com', repo)

export async function checkoutOf(ghq: Ghq, repo: string): Promise<string> {
  return checkoutUnder(await ghq.root(), repo)
}

/** 失敗は 1 行の理由を message に持つ Error で投げる。返すのは output の `warnings`。 */
export async function prepare(
  deps: { home: string; ghq: Ghq; setups: Set<Subprocess> },
  ref: IssueRef,
  { mode, cwd }: Pick<typeof bench.$inferSelect, 'mode' | 'cwd'>,
  log: string,
): Promise<string[]> {
  if (mode === 'in_place') {
    await clone(deps.ghq, ref.repo, cwd)
    return []
  }
  let warnings: string[] = []
  // repo が改名されても、作った worktree は作った時の checkout に登録されているので、checkout を引き直さない。
  if (!(await isLinkedWorktree(cwd))) {
    // cwd は作った時の名前から決めたので、今の名前と食い違えば、元の branch は改名前の checkout にしか無い。
    if (cwd !== worktreeOf(deps.home, ref)) {
      throw new Error(
        `the worktree ${cwd} is gone and the repo has been renamed to ${ref.repo} since, so close and reopen the Task to make the Bench again`,
      )
    }
    const checkout = await checkoutOf(deps.ghq, ref.repo)
    await clone(deps.ghq, ref.repo, checkout)
    warnings = await addWorktree(checkout, cwd, branchOf(ref))
  }
  await runSetup(cwd, log, deps.setups)
  return warnings
}

export function killSetups(setups: Set<Subprocess>) {
  for (const setup of setups) signalGroup(setup.pid, 'SIGKILL')
}

async function clone(ghq: Ghq, repo: string, checkout: string) {
  if (existsSync(checkout)) return
  await ghq.get(repo)
  // ghq は repo の今の名前の場所に clone するので、改名の前に決めた path には来ない。
  if (!existsSync(checkout)) throw new Error(`ghq get ${repo} did not clone it to ${checkout}`)
}

async function isLinkedWorktree(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  const answer = await git(
    path,
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-dir',
    '--git-common-dir',
  ).catch(() => null)
  const [toplevel, gitDir, commonDir] = answer?.split('\n') ?? []
  // git は path を realpath で答える。main の checkout では git dir と common dir が同じになる。
  return toplevel === realpathSync(path) && gitDir !== commonDir
}

async function addWorktree(checkout: string, path: string, branch: string): Promise<string[]> {
  // 消した worktree の登録が残っていると、同じ path にも同じ branch にも add できない。
  // prune は外付けの disk の上の worktree のような、tania と関係の無い登録まで外すので使わない。
  if (!existsSync(path)) await succeeds(git(checkout, 'worktree', 'remove', path))
  if (await succeeds(git(checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`))) {
    await git(checkout, 'worktree', 'add', path, branch)
    return []
  }
  const base = await defaultBranch(checkout)
  const warnings: string[] = []
  // Bench を開く操作に network を要求しないので、fetch できなければ手元の origin/<default> から作る。
  try {
    await git(checkout, 'fetch', 'origin', base)
  } catch (error) {
    warnings.push(
      `could not fetch origin/${base}, so the worktree starts from the local origin/${base}: ${messageOf(error)}`,
    )
  }
  await git(checkout, 'worktree', 'add', '-b', branch, path, `origin/${base}`)
  return warnings
}

async function defaultBranch(checkout: string): Promise<string> {
  const originHead = () => git(checkout, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  let head = await originHead().catch(() => null)
  if (head === null) {
    await succeeds(git(checkout, 'remote', 'set-head', 'origin', '--auto'))
    head = await originHead().catch(() => null)
  }
  if (!head?.startsWith('origin/')) throw new Error('could not find the default branch of origin')
  return head.slice('origin/'.length)
}

async function runSetup(worktree: string, log: string, setups: Set<Subprocess>) {
  const script = join(worktree, SETUP_SCRIPT)
  if (!existsSync(script)) {
    appendFileSync(log, `tania: no ${SETUP_SCRIPT}, so there is nothing to set up\n`)
    return
  }
  const output = openSync(log, 'a')
  let setup: Subprocess
  try {
    // 自分の process group で起こし、timeout と Backend の終了で子孫ごと止める。
    setup = Bun.spawn([script], {
      cwd: worktree,
      // Tab の外で動くので、TANIA_HOME も付け直さない。
      env: inheritableEnv(),
      stdin: 'ignore',
      stdout: output,
      stderr: output,
      detached: true,
    })
  } catch (error) {
    throw new Error(`spawn failed: ${messageOf(error)}`)
  } finally {
    closeSync(output)
  }
  setups.add(setup)
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SETUP_TIMEOUT_MS)
    })
    const code = await Promise.race([setup.exited, timedOut])
    clearTimeout(timer)
    if (code === null) {
      await stopGroup(setup)
      throw new Error(`timed out after ${SETUP_TIMEOUT_MS / 1000}s`)
    }
    if (setup.signalCode) throw new Error(`killed by ${setup.signalCode}`)
    if (code !== 0) throw new Error(`exit ${code}`)
  } finally {
    setups.delete(setup)
  }
}

// script が先に抜けても、SIGTERM を受けて後始末をしている子孫には猶予を残す。
async function stopGroup(setup: Subprocess) {
  signalGroup(setup.pid, 'SIGTERM')
  const deadline = Date.now() + SETUP_KILL_GRACE_MS
  while (Date.now() < deadline && signalGroup(setup.pid, 0)) await Bun.sleep(50)
  signalGroup(setup.pid, 'SIGKILL')
  await setup.exited
}

/** group に誰か居れば true。 */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(-pid, signal)
  } catch {
    return false
  }
}

export function git(cwd: string, ...args: string[]): Promise<string> {
  return command(['git', '-C', cwd, ...args], `git ${args.slice(0, 2).join(' ')}`)
}

// Backend が端末から起こされていると、git は認証を /dev/tty で尋ねて準備が止まる。
async function command(argv: string[], name: string): Promise<string> {
  const child = Bun.spawn(argv, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) {
    throw new Error(`${name} failed: ${stderr.trim().split('\n').at(-1) || `exit ${code}`}`)
  }
  return stdout.trim()
}

export async function succeeds(running: Promise<unknown>): Promise<boolean> {
  return running.then(
    () => true,
    () => false,
  )
}

export function messageOf(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error))
}
