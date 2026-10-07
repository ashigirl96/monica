import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'

import type { RepoPlace } from './contract.ts'

// workbench は ghq root を持たないので、checkout の path の末尾が ghq のレイアウトかで Repo を見分ける。
const GHQ_CHECKOUT = /\/github\.com\/([^/]+\/[^/]+)$/

// webview は home を知らないので、Repo の外の directory は Backend が `~` に畳む。
function outside(cwd: string): RepoPlace {
  const home = homedir()
  const path = cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
  return { repo: null, path, branch: null }
}

export async function repoOf(cwd: string): Promise<RepoPlace> {
  const git = Bun.spawn(
    [
      'git',
      '-C',
      cwd,
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
      '--path-format=absolute',
      '--git-dir',
      '--git-common-dir',
      '--show-prefix',
    ],
    { env: process.env, stdout: 'pipe', stderr: 'ignore' },
  )
  const [stdout, exitCode] = await Promise.all([new Response(git.stdout).text(), git.exited])
  if (exitCode !== 0) return outside(cwd)
  const [branch, gitDir, commonDir, prefix = ''] = stdout.split('\n')
  // linked worktree の common dir も checkout の `.git` なので、その親が checkout になる。
  if (!branch || !gitDir || !commonDir || basename(commonDir) !== '.git') return outside(cwd)
  const repo = GHQ_CHECKOUT.exec(dirname(commonDir))?.[1]
  if (!repo) return outside(cwd)
  return {
    repo,
    path: prefix.replace(/\/$/, '') || basename(cwd),
    // checkout では 2 つが同じ directory を指し、linked worktree でだけ分かれる。
    branch: gitDir === commonDir ? null : branch,
  }
}
