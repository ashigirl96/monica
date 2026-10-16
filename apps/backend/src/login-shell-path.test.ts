import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeFakeExecutable } from '@monica/workbench/testing'

import { loginShellPath } from './login-shell-path.ts'
import { untilGone } from './testing.ts'

setDefaultTimeout(20_000)

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeShell(script: string) {
  // pwd は symlink を解いた path を出す（macOS の tmpdir は /var → /private/var）。
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'monica-shell-')))
  dirs.push(dir)
  const shell = join(dir, 'zsh')
  writeFakeExecutable(shell, script)
  return { dir, shell }
}

test('reads the PATH a login shell prints between the delimiters, run from HOME', async () => {
  // rc の出力が前後に混ざっても区切りの間だけを読む。
  const { dir, shell } = fakeShell(
    `echo "rc noise"; [ "$1" = "-ilc" ] && [ "$DISABLE_AUTO_UPDATE" = true ] && PATH="$(pwd)/bin:/usr/bin" /bin/sh -c "$2"; echo "more noise"`,
  )

  expect(await loginShellPath({ SHELL: shell, HOME: dir, PATH: '/usr/bin:/bin' })).toBe(
    `${dir}/bin:/usr/bin`,
  )
})

test("fails with the shell's stderr when the login shell fails", async () => {
  const { dir, shell } = fakeShell(`echo "zshrc: parse error" >&2; exit 1`)

  await expect(loginShellPath({ SHELL: shell, HOME: dir, PATH: '/usr/bin:/bin' })).rejects.toThrow(
    `${shell} -ilc exited with 1: zshrc: parse error`,
  )
})

test('gives up on a login shell that does not finish within 5 seconds and kills it with the children holding its output', async () => {
  const { dir, shell } = fakeShell(
    'trap "" TERM; d=$(dirname "$0"); echo $$ > "$d/shell"; sleep 9 & echo $! > "$d/child"; wait; wait',
  )
  const startedAt = performance.now()

  await expect(loginShellPath({ SHELL: shell, HOME: dir, PATH: '/usr/bin:/bin' })).rejects.toThrow(
    `${shell} -ilc took over 5000ms`,
  )
  expect(performance.now() - startedAt).toBeLessThan(7000)
  for (const name of ['shell', 'child']) {
    expect(await untilGone(Number(readFileSync(join(dir, name), 'utf8')))).toBe(true)
  }
})
