import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import type { Ghq } from './prepare.ts'

export type Files = Record<string, { content: string; mode?: number }>

// auto maintenance は git が返った後も裏で .git/objects/maintenance.lock を作っては消し、snapshot の走査と競合する。
export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, '-c', 'maintenance.auto=false', ...args], {
    env: process.env,
  })
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
    'user.name=monica',
    '-c',
    'user.email=monica@example.com',
    'commit',
    '--allow-empty',
    '-m',
    message,
  )
  return git(repo, 'rev-parse', 'HEAD')
}

type Snapshot = { dirs: string[]; files: { path: string; data: Buffer; mode: number }[] }
type Template = { origin: Snapshot; refs: string; clone?: { snapshot: Snapshot; url: string } }

// origin と clone を git で作ると 1 回 100ms を越えるので、files の組ごとに 1 回だけ作り、2 回目からは写す。
// 写しは memory に持つ。bun test は worker の終わりに exit の listener を呼ばないので、disk に置くと TMPDIR に残る。
const templates = new Map<string, Template>()

function snapshot(dir: string): Snapshot {
  const taken: Snapshot = { dirs: [], files: [] }
  for (const path of readdirSync(dir, { recursive: true, encoding: 'utf8' }).toSorted()) {
    const stat = statSync(join(dir, path))
    if (stat.isDirectory()) taken.dirs.push(path)
    else taken.files.push({ path, data: readFileSync(join(dir, path)), mode: stat.mode & 0o777 })
  }
  return taken
}

function restore({ dirs, files }: Snapshot, to: string) {
  mkdirSync(to, { recursive: true })
  for (const path of dirs) mkdirSync(join(to, path), { recursive: true })
  for (const { path, data, mode } of files) writeFileSync(join(to, path), data, { mode })
}

// commit や branch を足した origin は template と食い違うので、refs が同じときだけ clone を写す。
function refsOf(repo: string): string {
  const dir = join(repo, '.git')
  const refs = readdirSync(join(dir, 'refs'), { recursive: true, encoding: 'utf8' })
    .map((name) => join('refs', name))
    .filter((name) => statSync(join(dir, name)).isFile())
  return ['HEAD', 'packed-refs', ...refs.toSorted()]
    .filter((name) => existsSync(join(dir, name)))
    .map((name) => `${name} ${readFileSync(join(dir, name), 'utf8')}`)
    .join('\n')
}

/** ghq の代わりに、`origins/<owner>/<repo>` の repo を `<root>/github.com/<owner>/<repo>` に clone する。 */
export function fakeGhq(scratch: string) {
  const root = join(scratch, 'ghq')
  const origins = join(scratch, 'origins')
  const gets: string[] = []
  const madeFrom = new Map<string, Template>()

  const checkout = (repo: string) => join(root, 'github.com', repo)

  function clone(repo: string) {
    const origin = join(origins, repo)
    const to = checkout(repo)
    mkdirSync(dirname(to), { recursive: true })
    const template = madeFrom.get(repo)
    if (template === undefined || refsOf(origin) !== template.refs) {
      git(origins, 'clone', '--quiet', origin, to)
      return
    }
    if (template.clone === undefined) {
      git(origins, 'clone', '--quiet', origin, to)
      template.clone = { snapshot: snapshot(to), url: origin }
      return
    }
    restore(template.clone.snapshot, to)
    const config = join(to, '.git', 'config')
    writeFileSync(config, readFileSync(config, 'utf8').replace(template.clone.url, origin))
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
      const key = JSON.stringify(Object.entries(files))
      let template = templates.get(key)
      if (template === undefined) {
        mkdirSync(path, { recursive: true })
        git(path, 'init', '--quiet', '--initial-branch=main')
        commit(path, files, 'init')
        template = { origin: snapshot(path), refs: refsOf(path) }
        templates.set(key, template)
      } else {
        restore(template.origin, path)
      }
      madeFrom.set(repo, template)
      return path
    },
  }
}
