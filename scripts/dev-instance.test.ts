import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { devInstance, isReleaseHome } from './dev-instance'

const scratch = mkdtempSync(join(tmpdir(), 'dev-instance-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function homeAt(...segments: string[]): string {
  const home = join(scratch, ...segments)
  mkdirSync(home, { recursive: true })
  return home
}

test('既定の home は release と分けた identifier と port 1420、ブラウザの口は 19381、Chrome Extension の Vite は 19781', () => {
  expect(devInstance(join(homedir(), '.monica-dev'))).toEqual({
    identifier: 'com.ashigirl96.monica.dev',
    preferredPort: 1420,
    browserPort: 19381,
    webPort: 19581,
    extensionPort: 19781,
  })
})

test('ほかの home は basename の先頭の . を外し、使えない文字を - にして hash を付ける', () => {
  const { identifier, preferredPort } = devInstance(homeAt('.monica_s46'))
  expect(identifier).toMatch(/^com\.ashigirl96\.monica\.dev\.monica-s46-[0-9a-f]{6}$/)
  expect(preferredPort).toBeGreaterThan(1420)
})

// 散らした port が既定の home の port や、ブラウザの口と 2 つの Vite の port どうしで重なると、片方の bind が落ちる。
test('ほかの home のブラウザの口と 2 つの Vite の port は、既定の home とも互いとも重ならない範囲に散らす', () => {
  const ports = ['s1', 's2', 's3', 's4', 's5'].map((name) => devInstance(homeAt(name)))
  for (const { browserPort, webPort, extensionPort } of ports) {
    expect(browserPort).toBeWithin(19382, 19482)
    expect(webPort).toBeWithin(19582, 19682)
    expect(extensionPort).toBeWithin(19782, 19882)
  }
  expect(new Set(ports.map((p) => p.browserPort)).size).toBeGreaterThan(1)
  expect(new Set(ports.map((p) => p.extensionPort)).size).toBeGreaterThan(1)
})

// macOS の $TMPDIR の下は /var と /private/var の 2 通りに書ける。
test('同じ home を symlink 経由で書いても同じ instance になる', () => {
  const home = homeAt('real', 'monica-s2')
  const link = join(scratch, 'link')
  symlinkSync(home, link)
  expect(devInstance(link)).toEqual(devInstance(home))
})

test('basename が同じでも場所が違う home は別の identifier になる', () => {
  const a = devInstance(homeAt('a', 'monica-s3'))
  const b = devInstance(homeAt('b', 'monica-s3'))
  expect(a.identifier).not.toBe(b.identifier)
})

test('release の ~/.monica だけを release の home とし、名前が前方一致する dev の home は含めない', () => {
  expect(isReleaseHome(join(homedir(), '.monica'))).toBe(true)
  expect(isReleaseHome(join(homedir(), '.monica-dev'))).toBe(false)
})
