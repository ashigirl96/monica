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

test('既定の home は release と分けた identifier と port 1420、notes の口は 19381', () => {
  expect(devInstance(join(homedir(), '.tania-dev'))).toEqual({
    identifier: 'com.ashigirl96.tania.dev',
    preferredPort: 1420,
    notesPort: 19381,
    webPort: 19581,
  })
})

test('ほかの home は basename の先頭の . を外し、使えない文字を - にして hash を付ける', () => {
  const { identifier, preferredPort } = devInstance(homeAt('.tania_s46'))
  expect(identifier).toMatch(/^com\.ashigirl96\.tania\.dev\.tania-s46-[0-9a-f]{6}$/)
  expect(preferredPort).toBeGreaterThan(1420)
})

// 散らした port が既定の home の port や、notes の口と Vite の port どうしで重なると、片方の bind が落ちる。
test('ほかの home の notes の口と Vite の port は、既定の home とも互いとも重ならない範囲に散らす', () => {
  const ports = ['s1', 's2', 's3', 's4', 's5'].map((name) => devInstance(homeAt(name)))
  for (const { notesPort, webPort } of ports) {
    expect(notesPort).toBeWithin(19382, 19482)
    expect(webPort).toBeWithin(19582, 19682)
  }
  expect(new Set(ports.map((p) => p.notesPort)).size).toBeGreaterThan(1)
})

// macOS の $TMPDIR の下は /var と /private/var の 2 通りに書ける。
test('同じ home を symlink 経由で書いても同じ instance になる', () => {
  const home = homeAt('real', 'tania-s2')
  const link = join(scratch, 'link')
  symlinkSync(home, link)
  expect(devInstance(link)).toEqual(devInstance(home))
})

test('basename が同じでも場所が違う home は別の identifier になる', () => {
  const a = devInstance(homeAt('a', 'tania-s3'))
  const b = devInstance(homeAt('b', 'tania-s3'))
  expect(a.identifier).not.toBe(b.identifier)
})

test('release の ~/.tania だけを release の home とし、名前が前方一致する dev の home は含めない', () => {
  expect(isReleaseHome(join(homedir(), '.tania'))).toBe(true)
  expect(isReleaseHome(join(homedir(), '.tania-dev'))).toBe(false)
})
