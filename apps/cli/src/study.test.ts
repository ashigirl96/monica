import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { study } from '@monica/study/schema'
import { writeFakeExecutable } from '@monica/workbench/testing'
import { eq } from 'drizzle-orm'

import { cleanUp, monicaHome, serveBackend } from './testing.ts'

afterEach(cleanUp)

const RECORDED = ['ZDOTDIR', 'MONICA_STUDY_DIR', 'NPM_CONFIG_PREFIX', 'HOME', 'FROM_ENV_SH']

// 起こされた shell は cwd・argv・env を書いて exit 3 で抜ける。
function fakeShell(home: string, name: string) {
  const shell = join(home, name)
  writeFakeExecutable(
    shell,
    [
      'pwd -P > "$RECORD"',
      'printf "%s\\n" "$0 $*" >> "$RECORD"',
      ...RECORDED.map((key) => `printf "%s\\n" "\${${key}-unset}" >> "$RECORD"`),
      'exit 3',
    ].join('\n'),
  )
  return shell
}

async function monicaStudy(home: string, args: string[], env: Record<string, string> = {}) {
  const record = join(home, 'record')
  const child = Bun.spawn(['bun', join(import.meta.dir, 'main.ts'), 'study', ...args], {
    env: { PATH: process.env.PATH!, HOME: '/users/me', MONICA_HOME: home, RECORD: record, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  const lines = existsSync(record) ? readFileSync(record, 'utf8').trimEnd().split('\n') : null
  const shell: Record<string, string | undefined> | null = lines && {
    cwd: lines[0],
    argv: lines[1],
    ...Object.fromEntries(RECORDED.map((key, i) => [key, lines[i + 2]])),
  }
  return { code, stderr, shell }
}

function withStudy(home: string, id: string) {
  const backend = serveBackend(home)
  const now = new Date(0)
  backend.db.insert(study).values({ id, createdAt: now, lastActiveAt: now }).run()
  const dir = join(home, 'studies', id)
  mkdirSync(dir, { recursive: true })
  return { ...backend, dir: realpathSync(dir) }
}

const ID = 'study-0190abcd-ef01-7000-8000-000000000001'

test('study shell with a unique prefix of any length starts the shell in the Study dir with the study ZDOTDIR and exits 0', async () => {
  const home = monicaHome()
  const { db, dir } = withStudy(home, ID)
  const shell = fakeShell(home, 'zsh')

  for (const prefix of ['0190abcd-e', 'STUDY-0190abcd', ID]) {
    const result = await monicaStudy(home, ['shell', prefix], { SHELL: shell })

    expect(result).toEqual({
      code: 0,
      stderr: '',
      shell: {
        cwd: dir,
        argv: `${shell} -i`,
        ZDOTDIR: join(home, 'shell/study/zdotdir'),
        MONICA_STUDY_DIR: join(home, 'studies', ID),
        NPM_CONFIG_PREFIX: join(home, 'studies', ID, 'env/npm'),
        HOME: '/users/me',
        FROM_ENV_SH: 'unset',
      },
    })
  }
  expect(
    db.select().from(study).where(eq(study.id, ID)).get()!.lastActiveAt.getTime(),
  ).toBeGreaterThan(0)
})

test('study shell for a shell other than zsh goes through sh, which reads env/env.sh first', async () => {
  const home = monicaHome()
  const { dir } = withStudy(home, ID)
  mkdirSync(join(dir, 'env'))
  writeFileSync(join(dir, 'env/env.sh'), 'export FROM_ENV_SH=yes\n')
  const shell = fakeShell(home, 'bash')

  const result = await monicaStudy(home, ['shell', '0190abcd'], { SHELL: shell })

  expect(result).toMatchObject({
    code: 0,
    shell: {
      cwd: dir,
      argv: `${shell} -i`,
      ZDOTDIR: 'unset',
      NPM_CONFIG_PREFIX: join(home, 'studies', ID, 'env/npm'),
      HOME: '/users/me',
      FROM_ENV_SH: 'yes',
    },
  })
})

test('study shell with a prefix two Studies share exits 1 naming both on the first stderr line and starts no shell', async () => {
  const home = monicaHome()
  const { db } = withStudy(home, ID)
  const other = 'study-0190abcd-ef01-7000-8000-000000000002'
  db.insert(study).values({ id: other, createdAt: new Date(), lastActiveAt: new Date() }).run()

  const result = await monicaStudy(home, ['shell', '0190abcd'], { SHELL: fakeShell(home, 'zsh') })

  expect(result.code).toBe(1)
  expect(result.shell).toBeNull()
  const first = result.stderr.split('\n')[0]!
  expect(first).toStartWith('BAD_REQUEST: ')
  expect(first).toContain(ID)
  expect(first).toContain(other)
})

test('study shell exits 1 with NOT_FOUND for a prefix no Study has, 1 with BAD_REQUEST without a prefix, and 2 without a Backend', async () => {
  const home = monicaHome()
  withStudy(home, ID)
  const shell = fakeShell(home, 'zsh')
  const backendless = monicaHome()

  const missing = await monicaStudy(home, ['shell', 'ffff'], { SHELL: shell })
  const bare = await monicaStudy(home, ['shell'], { SHELL: shell })
  const noBackend = await monicaStudy(backendless, ['shell', '0190abcd'], { SHELL: shell })

  expect(missing).toEqual({
    code: 1,
    stderr: "NOT_FOUND: no Study's id starts with ffff\n",
    shell: null,
  })
  expect(bare).toEqual({
    code: 1,
    stderr: 'BAD_REQUEST: usage: monica study shell <short id>\n',
    shell: null,
  })
  expect(noBackend).toEqual({
    code: 2,
    stderr: 'BACKEND_NOT_RUNNING: start the monica desktop app\n',
    shell: null,
  })
})
