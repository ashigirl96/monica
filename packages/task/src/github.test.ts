import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ghAuthToken } from './github.ts'

const path = process.env.PATH
// macOS は新しく書いた実行 file を初めて exec するたびに検査を挟むので、偽の gh は 1 つの file を書き直して使い回す。
const dir = mkdtempSync(join(tmpdir(), 'monica-gh-'))

afterEach(() => {
  process.env.PATH = path
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fakeGh(script: string) {
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  process.env.PATH = `${dir}:${path}`
}

const signal = () => AbortSignal.timeout(5000)

test('ghAuthToken asks gh for the github.com token', async () => {
  fakeGh(`[ "$*" = "auth token --hostname github.com" ] && echo gho_token`)

  const token = await ghAuthToken(signal())

  // 本物の gh に届いてしまったとき、失敗の表示に本物の token を出さない。
  expect(token === 'gho_token' ? 'the fake token' : 'another token').toBe('the fake token')
})

test('ghAuthToken fails when gh is not logged in', async () => {
  fakeGh(`echo "no oauth token found for github.com" >&2; exit 1`)

  await expect(ghAuthToken(signal())).rejects.toThrow(
    '`gh auth token` failed: no oauth token found for github.com; run `gh auth login`',
  )
})

test('ghAuthToken fails when gh prints no token', async () => {
  fakeGh('exit 0')

  await expect(ghAuthToken(signal())).rejects.toThrow('`gh auth token` failed: it printed no token')
})

test('ghAuthToken fails when there is no gh', async () => {
  process.env.PATH = '/nonexistent'

  await expect(ghAuthToken(signal())).rejects.toThrow('`gh auth token` failed')
})
