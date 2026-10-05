import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Ghq } from './prepare.ts'

export type Files = Record<string, { content: string; mode?: number }>

export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { env: process.env })
  if (!result.success) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.toString().trim()
}

// CI には git の user が無いので、commit に author を渡す。
export function commit(repo: string, files: Files, message: string) {
  for (const [path, { content, mode }] of Object.entries(files)) {
    const file = join(repo, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
    if (mode !== undefined) chmodSync(file, mode)
  }
  git(repo, 'add', '--all')
  git(
    repo,
    '-c',
    'user.name=tania',
    '-c',
    'user.email=tania@example.com',
    'commit',
    '--allow-empty',
    '-m',
    message,
  )
  return git(repo, 'rev-parse', 'HEAD')
}

/** ghq の代わりに、`origins/<owner>/<repo>` の repo を `<root>/github.com/<owner>/<repo>` に clone する。 */
export function fakeGhq(scratch: string) {
  const root = join(scratch, 'ghq')
  const origins = join(scratch, 'origins')
  const gets: string[] = []

  const checkout = (repo: string) => join(root, 'github.com', repo)

  function clone(repo: string) {
    mkdirSync(dirname(checkout(repo)), { recursive: true })
    git(origins, 'clone', '--quiet', join(origins, repo), checkout(repo))
  }

  const client: Ghq = {
    root: () => Promise.resolve(root),
    async get(repo) {
      gets.push(repo)
      clone(repo)
    },
  }

  return {
    client,
    gets,
    checkout,
    clone,
    /** default branch が main の origin を作り、最初の commit に `files` を入れる。 */
    origin(repo: string, files: Files = {}) {
      const path = join(origins, repo)
      mkdirSync(path, { recursive: true })
      git(path, 'init', '--quiet', '--initial-branch=main')
      commit(path, files, 'init')
      return path
    },
  }
}
