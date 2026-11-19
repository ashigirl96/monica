import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { oneLine } from './github.ts'
import type { IssueRef } from './ref.ts'

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

// `claude --worktree <name>` の名前。置き場と branch は Claude Code がこの名前から決める。
export const worktreeNameOf = ({ number }: Pick<IssueRef, 'number'>) => `issue-${number}`

// Claude Code が branch の名前を `worktree-<name>` に固定している。
export const branchOf = (ref: Pick<IssueRef, 'number'>) => `worktree-${worktreeNameOf(ref)}`

export const worktreeOf = (checkout: string, ref: Pick<IssueRef, 'number'>) =>
  join(checkout, '.claude', 'worktrees', worktreeNameOf(ref))

/** `worktreeOf` の形の path なら、その checkout を返す。 */
export function checkoutOfWorktree(path: string): string | null {
  const worktrees = dirname(path)
  if (basename(worktrees) !== 'worktrees' || basename(dirname(worktrees)) !== '.claude') return null
  return dirname(dirname(worktrees))
}

export const checkoutUnder = (ghqRoot: string, repo: string) => join(ghqRoot, 'github.com', repo)

export async function checkoutOf(ghq: Ghq, repo: string): Promise<string> {
  return checkoutUnder(await ghq.root(), repo)
}

export async function clone(ghq: Ghq, repo: string, checkout: string) {
  if (existsSync(checkout)) return
  await ghq.get(repo)
  // ghq は repo の今の名前の場所に clone するので、改名の前に決めた path には来ない。
  if (!existsSync(checkout)) throw new Error(`ghq get ${repo} did not clone it to ${checkout}`)
}

export function git(cwd: string, ...args: string[]): Promise<string> {
  return command(['git', '-C', cwd, ...args], gitName(args))
}

/** `from` の stdout を byte のまま `to` の stdin に渡し、`to` の stdout を返す。 */
export async function gitPiped(cwd: string, from: string[], to: string[]): Promise<string> {
  const source = spawned(['git', '-C', cwd, ...from], 'ignore')
  const [output] = await Promise.all([
    command(['git', '-C', cwd, ...to], gitName(to), source.stdout),
    succeeded(source, gitName(from)),
  ])
  return output
}

const gitName = (args: string[]) => `git ${args.slice(0, 2).join(' ')}`

async function command(
  argv: string[],
  name: string,
  stdin: 'ignore' | ReadableStream<Uint8Array> = 'ignore',
): Promise<string> {
  const child = spawned(argv, stdin)
  const [stdout] = await Promise.all([new Response(child.stdout).text(), succeeded(child, name)])
  return stdout.trim()
}

// Backend が端末から起こされていると、git は認証を /dev/tty で尋ねて止まる。
function spawned(argv: string[], stdin: 'ignore' | ReadableStream<Uint8Array>) {
  return Bun.spawn(argv, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdin,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function succeeded(child: ReturnType<typeof spawned>, name: string) {
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  if (code !== 0) {
    throw new Error(`${name} failed: ${stderr.trim().split('\n').at(-1) || `exit ${code}`}`)
  }
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
