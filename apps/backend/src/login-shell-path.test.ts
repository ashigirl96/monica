import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loginShellPath } from './login-shell-path.ts'

const dirs: string[] = []
// macOS は新しく書いた実行 file を初めて exec するたびに検査を挟むので、偽の shell は 1 つの file を書き直して使い回す。
const shellDir = mkdtempSync(join(tmpdir(), 'monica-zsh-'))

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
afterAll(() => rmSync(shellDir, { recursive: true, force: true }))

function fakeShell(script: string) {
  // pwd は symlink を解いた path を出す（macOS の tmpdir は /var → /private/var）。
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'monica-shell-')))
  dirs.push(dir)
  const shell = join(shellDir, 'zsh')
  writeFileSync(shell, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return { dir, shell }
}

test('reads the PATH a login shell prints between the delimiters, run from HOME', () => {
  // rc の出力が前後に混ざっても区切りの間だけを読む。
  const { dir, shell } = fakeShell(
    `echo "rc noise"; [ "$1" = "-ilc" ] && [ "$DISABLE_AUTO_UPDATE" = true ] && PATH="$(pwd)/bin:/usr/bin" /bin/sh -c "$2"; echo "more noise"`,
  )

  expect(loginShellPath({ SHELL: shell, HOME: dir, PATH: '/usr/bin:/bin' })).toBe(
    `${dir}/bin:/usr/bin`,
  )
})

test("fails with the shell's stderr when the login shell fails", () => {
  const { dir, shell } = fakeShell(`echo "zshrc: parse error" >&2; exit 1`)

  expect(() => loginShellPath({ SHELL: shell, HOME: dir, PATH: '/usr/bin:/bin' })).toThrow(
    `${shell} -ilc exited with 1: zshrc: parse error`,
  )
})
