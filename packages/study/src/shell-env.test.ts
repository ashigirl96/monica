import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { migrations } from '../migrations/index.ts'
import { createStudyLedger } from './server.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function startedHome(home = scratchDir('monica-study-')) {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  const studyLedger = createStudyLedger({ db, home, openInEditor: async () => {} })
  studyLedger.start()
  studyLedger.stop()
  return home
}

async function zsh(home: string, studyDir: string, user: string, userZdotdir = '') {
  const child = Bun.spawn(
    [
      'zsh',
      '-i',
      '-c',
      'print -r -- "$PATH"; print -r -- "${ZDOTDIR-unset}"; print -r -- "$HOME"; print -r -- "${FROM_ENV_SH-unset}"',
    ],
    {
      env: {
        HOME: user,
        ZDOTDIR: join(home, 'shell/study/zdotdir'),
        MONICA_USER_ZDOTDIR: userZdotdir,
        MONICA_STUDY_DIR: studyDir,
        PATH: '/usr/bin:/bin',
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000,
    },
  )
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const [path = '', zdotdir, shellHome, fromEnvSh] = stdout.trimEnd().split('\n').slice(-4)
  return { code: await child.exited, stderr, path, zdotdir, shellHome, fromEnvSh }
}

function recordingUser(dir: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.zshenv'), 'print -r -- .zshenv >> "$HOME/order"\n')
  writeFileSync(
    join(dir, '.zshrc'),
    'print -r -- .zshrc >> "$HOME/order"\nPATH="/from/user/zshrc:$PATH"\n',
  )
}

test.skipIf(!Bun.which('zsh'))(
  "an interactive zsh with the study ZDOTDIR reads the user's .zshenv and .zshrc, then env/env.sh, and leaves ZDOTDIR as the user had it",
  async () => {
    const home = startedHome()
    const user = scratchDir('monica-user-')
    recordingUser(user)
    const studyDir = scratchDir('monica-study-dir-')
    mkdirSync(join(studyDir, 'env'))
    writeFileSync(
      join(studyDir, 'env/env.sh'),
      'export PATH="/from/env-sh:$PATH"\nexport FROM_ENV_SH=yes\n',
    )

    const unset = await zsh(home, studyDir, user)
    const own = await zsh(home, studyDir, user, user)

    expect(readFileSync(join(user, 'order'), 'utf8')).toBe('.zshenv\n.zshrc\n'.repeat(2))
    const dirs = unset.path.split(':')
    expect(dirs.indexOf('/from/env-sh')).toBeGreaterThanOrEqual(0)
    expect(dirs.indexOf('/from/env-sh')).toBeLessThan(dirs.indexOf('/from/user/zshrc'))
    expect(unset).toMatchObject({ zdotdir: 'unset', shellHome: user, fromEnvSh: 'yes' })
    expect(own).toMatchObject({ zdotdir: user, shellHome: user, fromEnvSh: 'yes' })
  },
)

test.skipIf(!Bun.which('zsh'))(
  'the shell starts when the Study has no env/env.sh yet',
  async () => {
    const home = startedHome()
    const user = scratchDir('monica-user-')
    recordingUser(user)

    const result = await zsh(home, scratchDir('monica-study-dir-'), user)

    expect(result).toMatchObject({ code: 0, stderr: '', fromEnvSh: 'unset', zdotdir: 'unset' })
    expect(result.path.split(':')[0]).toBe('/from/user/zshrc')
  },
)

test('start rewrites only the study shell files whose content drifted', () => {
  const home = startedHome()
  const zshrc = join(home, 'shell/study/zdotdir/.zshrc')
  const zshenv = join(home, 'shell/study/zdotdir/.zshenv')
  const written = readFileSync(zshrc, 'utf8')
  writeFileSync(zshrc, '# drifted\n')
  const past = new Date(0)
  for (const file of [zshrc, zshenv]) utimesSync(file, past, past)

  startedHome(home)

  expect(readFileSync(zshrc, 'utf8')).toBe(written)
  expect(statSync(zshrc).mtimeMs).not.toBe(0)
  expect(statSync(zshenv).mtimeMs).toBe(0)
})
