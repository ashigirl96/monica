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

import { writeFakeExecutable } from './fake-executable.ts'
import { cleanUp, onCleanup, setup } from './testing.ts'

afterEach(cleanUp)

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'monica-user-'))
  onCleanup(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function run(argv: string[], env: Record<string, string>) {
  const child = Bun.spawn(argv, { env, stdout: 'pipe', stderr: 'pipe', timeout: 5000 })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code: await child.exited, stdout, stderr }
}

async function startedHome() {
  const { home, workbenchLedger } = setup()
  await workbenchLedger.start()
  return home
}

function recordingStartupFiles(dir: string, label: string, extra: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true })
  for (const file of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
    writeFileSync(
      join(dir, file),
      `print -r -- ${label}${file} >> "$HOME/order"\n${extra[file] ?? ''}`,
    )
  }
}

test.skipIf(!Bun.which('zsh'))(
  "a login zsh in a Tab reads the user's startup files in order, then puts the home's bin first and leaves ZDOTDIR unset",
  async () => {
    const home = await startedHome()
    const user = scratchDir()
    recordingStartupFiles(user, '', { '.zshrc': 'PATH="/from/user/zshrc:$PATH"\n' })

    const result = await run(
      ['zsh', '--login', '-i', '-c', 'print -r -- "$PATH"; print -r -- "${ZDOTDIR-unset}"'],
      {
        HOME: user,
        MONICA_HOME: home,
        ZDOTDIR: join(home, 'shell/zdotdir'),
        MONICA_USER_ZDOTDIR: '',
        PATH: `${join(home, 'bin')}:/usr/bin:/bin`,
      },
    )

    const [path = '', zdotdir] = result.stdout.trimEnd().split('\n').slice(-2)
    expect(readFileSync(join(user, 'order'), 'utf8')).toBe('.zshenv\n.zprofile\n.zshrc\n.zlogin\n')
    expect(path.split(':')[0]).toBe(join(home, 'bin'))
    expect(path.split(':').filter((dir) => dir === join(home, 'bin'))).toHaveLength(1)
    expect(path).toContain('/from/user/zshrc')
    expect(zdotdir).toBe('unset')
  },
)

test.skipIf(!Bun.which('zsh'))(
  'a user whose .zshenv moves ZDOTDIR gets the rest of the startup files from the new place and keeps it exported',
  async () => {
    const home = await startedHome()
    const user = scratchDir()
    recordingStartupFiles(join(user, 'dots'), 'dots', {
      '.zshenv': 'ZDOTDIR="$HOME/moved"\n',
    })
    recordingStartupFiles(join(user, 'moved'), 'moved')

    const result = await run(['zsh', '--login', '-i', '-c', 'printenv ZDOTDIR'], {
      HOME: user,
      MONICA_HOME: home,
      ZDOTDIR: join(home, 'shell/zdotdir'),
      MONICA_USER_ZDOTDIR: join(user, 'dots'),
      PATH: `${join(home, 'bin')}:/usr/bin:/bin`,
    })

    expect(readFileSync(join(user, 'order'), 'utf8')).toBe(
      'dots.zshenv\nmoved.zprofile\nmoved.zshrc\nmoved.zlogin\n',
    )
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe(join(user, 'moved'))
  },
)

async function claudeThroughWrapper(
  home: string,
  path: string,
  env: Record<string, string>,
  args = ['--print', 'hi'],
) {
  return run([join(home, 'bin/claude'), ...args], { PATH: path, ...env })
}

function realClaude(): string {
  const dir = scratchDir()
  writeFakeExecutable(join(dir, 'claude'), 'printf "%s\\n" "$@"')
  return dir
}

const inTab = { MONICA_TERMINAL_SESSION_ID: 'ts-a' }

test.each([
  ["a Tab's claude gets the hook settings", inTab, ['--print', 'hi'], true],
  ["a Tab's claude started with a prompt gets them too", inTab, ['fix the bug'], true],
  [
    'a claude subcommand gets none, since claude reads a subcommand after --settings as a prompt',
    inTab,
    ['mcp', 'list'],
    false,
  ],
  [
    "a claude started from an agent's Bash tool gets none",
    { ...inTab, CLAUDECODE: '1' },
    ['--print', 'hi'],
    false,
  ],
  ['a claude outside any Tab gets none', {}, ['--print', 'hi'], false],
])('the claude wrapper runs the next claude on PATH: %s', async (_name, env, args, hooked) => {
  const home = await startedHome()
  const real = realClaude()

  const result = await claudeThroughWrapper(
    home,
    `${join(home, 'bin')}:${real}:/usr/bin:/bin`,
    env,
    args,
  )

  const settings = [
    '--settings',
    join(home, 'shell/claude/settings.json'),
    '--permission-mode=bypassPermissions',
  ]
  expect(result.stdout.trimEnd().split('\n')).toEqual([...(hooked ? settings : []), ...args])
})

test('the claude wrapper reaches the real claude past another wrapper that hands back to the first claude on PATH', async () => {
  const home = await startedHome()
  const real = realClaude()
  const other = scratchDir()
  writeFakeExecutable(
    join(other, 'claude'),
    [
      'self="$(cd "$(dirname "$0")" && pwd)"',
      'IFS=:',
      'for dir in $PATH; do [ "$dir" = "$self" ] && continue; [ -x "$dir/claude" ] && exec "$dir/claude" "$@"; done',
      'exit 127',
    ].join('\n'),
  )

  const result = await claudeThroughWrapper(
    home,
    `${join(home, 'bin')}:${other}:${real}:/usr/bin:/bin`,
    { MONICA_TERMINAL_SESSION_ID: 'ts-a' },
  )

  expect(result.code).toBe(0)
  expect(result.stdout.trimEnd().split('\n')).toEqual([
    '--settings',
    join(home, 'shell/claude/settings.json'),
    '--permission-mode=bypassPermissions',
    '--print',
    'hi',
  ])
})

test('start rewrites only the shell files whose content drifted', async () => {
  const { home, workbenchLedger, restartBackend } = setup()
  await workbenchLedger.start()
  const zshrc = join(home, 'shell/zdotdir/.zshrc')
  const untouched = [
    'shell/zdotdir/.zshenv',
    'shell/zdotdir/.zprofile',
    'shell/zdotdir/.zlogin',
    'bin/claude',
    'shell/claude/settings.json',
  ].map((file) => join(home, file))
  const written = readFileSync(zshrc, 'utf8')
  writeFileSync(zshrc, '# drifted\n')
  const past = new Date(0)
  for (const file of [zshrc, ...untouched]) utimesSync(file, past, past)

  await restartBackend().workbenchLedger.start()

  expect(readFileSync(zshrc, 'utf8')).toBe(written)
  expect(statSync(zshrc).mtimeMs).not.toBe(0)
  expect(untouched.map((file) => statSync(file).mtimeMs)).toEqual(untouched.map(() => 0))
})

test("a new Terminal Session is created with the Tab's env", async () => {
  const zdotdir = process.env.ZDOTDIR
  onCleanup(() => {
    if (zdotdir === undefined) delete process.env.ZDOTDIR
    else process.env.ZDOTDIR = zdotdir
  })
  process.env.ZDOTDIR = '/users/own/zdotdir'
  const { home, ptyd, client } = setup()

  const { tab } = await client.runspace.create({ rows: 24, cols: 80 })

  const created = await ptyd.received((op) => op.op === 'create')
  expect(created).toMatchObject({
    env: expect.arrayContaining([
      ['MONICA_HOME', home],
      ['MONICA_TERMINAL_SESSION_ID', tab.terminalSessionId],
      ['ZDOTDIR', join(home, 'shell/zdotdir')],
      ['MONICA_USER_ZDOTDIR', '/users/own/zdotdir'],
      ['PATH', `${join(home, 'bin')}:${process.env.PATH}`],
    ]),
  })
})
