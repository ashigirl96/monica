import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeFakeExecutable } from '@monica/workbench/testing'

import { ghAuthToken } from './github.ts'

const path = process.env.PATH
const dirs: string[] = []

afterEach(() => {
  process.env.PATH = path
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeGh(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'monica-gh-'))
  dirs.push(dir)
  writeFakeExecutable(join(dir, 'gh'), script)
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
