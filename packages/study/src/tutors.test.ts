import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeTutors } from './server.ts'

const cleanups: (() => unknown)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'monica-tutors-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('writing the Tutors copies every file byte for byte, nested dirs included, and leaves nothing from the last start', async () => {
  const from = tempDir()
  mkdirSync(join(from, 'skills/repository'), { recursive: true })
  writeFileSync(join(from, 'TEACHING.md'), '# teach\n')
  writeFileSync(join(from, 'skills/repository/SKILL.md'), new Uint8Array([0, 1, 254, 255]))
  const to = join(tempDir(), 'tutors')
  mkdirSync(join(to, 'skills/gone'), { recursive: true })
  writeFileSync(join(to, 'stale.md'), 'old')
  writeFileSync(join(to, 'skills/gone/SKILL.md'), 'old')
  writeFileSync(join(to, 'TEACHING.md'), 'old teaching, longer than the new one')

  expect(await writeTutors(from, to)).toBe(to)

  expect(readFileSync(join(to, 'TEACHING.md'), 'utf8')).toBe('# teach\n')
  expect([...readFileSync(join(to, 'skills/repository/SKILL.md'))]).toEqual([0, 1, 254, 255])
  expect(existsSync(join(to, 'stale.md'))).toBe(false)
  expect(existsSync(join(to, 'skills/gone'))).toBe(false)
})
