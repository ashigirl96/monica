import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeFakeExecutable } from '@monica/workbench/testing'

import { defaultGhq, git } from './prepare.ts'

const { PATH: path, GIT_TERMINAL_PROMPT: terminalPrompt } = process.env
const dirs: string[] = []

afterEach(() => {
  process.env.PATH = path
  if (terminalPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT
  else process.env.GIT_TERMINAL_PROMPT = terminalPrompt
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('git and ghq run with GIT_TERMINAL_PROMPT=0 so that they never ask on the terminal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'monica-prepare-'))
  dirs.push(dir)
  writeFakeExecutable(join(dir, 'git'), 'echo "$GIT_TERMINAL_PROMPT"')
  writeFakeExecutable(join(dir, 'ghq'), 'echo "$GIT_TERMINAL_PROMPT"')
  process.env.PATH = `${dir}:${path}`
  delete process.env.GIT_TERMINAL_PROMPT

  expect(await git(dir, 'version')).toBe('0')
  expect(await defaultGhq.root()).toBe('0')
})
