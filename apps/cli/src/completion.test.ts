import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Command } from 'commander'
import { kebabCase } from 'trpc-cli'

import { type Client, connect as connectTo } from './backend.ts'
import { completers } from './contract.ts'
import { createProgram, runCli } from './program.ts'
import { backendWithTasks, cleanUp, monica } from './testing.ts'

const cleanups: (() => void)[] = []
const onCleanup = (cleanup: () => void) => cleanups.push(cleanup)

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
  cleanUp()
})

test('__complete lists the subcommands with their descriptions for zsh', async () => {
  const result = await monica(['__complete', '--', 'task', ''], () => null)

  expect(result).toEqual({
    code: 0,
    stdout:
      'sync:Copy the Issues of every open Task, or of one Task given its ref, from GitHub\n' +
      'list:List open Tasks in the order they were tracked\n' +
      'run:Start claude with a first prompt (/tackle if left out) in a new Tab of the Bench of an open Task, tracking the Issue and opening and preparing the Bench first, or resume the last claude of the Bench once it has ended\n' +
      'current:Show the Task of the Tab this runs in\n' +
      "attach:Move the Tab this runs in into the Bench of an open Task, tracking the Issue when it is not tracked and opening the Bench in place when it has none, and make the Tab's claude a Run of the Task\n" +
      'close:Close a Task and take down its Bench: the worktree, the branch issue-n, the Runspace and its Tabs, all but the Tab this runs in\n' +
      'reopen:Reopen a closed Task; the next run or attach opens its Bench anew\n' +
      'show:Show a Task, open or closed, and its Runs with the Agent Session ids claude --resume takes\n' +
      'help:display help for command\n',
    stderr: '',
  })
})

test('__complete lists the options of the command and of its parents for a word starting with -', async () => {
  const result = await monica(['__complete', '--', 'task', 'run', '-'], () => null)

  expect(result.stdout).toBe(
    "--in-place:use the Repo's checkout as the cwd, with no worktree and no setup\n" +
      '--force:start a new Run even when the Issue has open Blockers\n' +
      '--help:display help for command\n' +
      '--format:output format\n',
  )
})

test('__complete lists the choices after an option that takes a value, and skips the value after it', async () => {
  const value = await monica(['__complete', '--', 'task', 'list', '--format', ''], () => null)
  const joined = await monica(['__complete', '--', 'task', 'list', '--format='], () => null)
  const after = await monica(['__complete', '--', '--format', 'json', 'workbench', ''], () => null)

  expect(value.stdout).toBe('text\njson\n')
  expect(joined.stdout).toBe('--format=text\n--format=json\n')
  expect(after.stdout).toBe(
    'terminal-session:Available subcommands: list\n' +
      'agent-session:Available subcommands: list\n' +
      'help:display help for command\n',
  )
})

test('__complete lists the open Tasks with their titles for the ref, and the closed ones for reopen', async () => {
  const connect = backendWithTasks()

  const run = await monica(['__complete', '--', 'task', 'run', ''], connect)
  const reopen = await monica(['__complete', '--', 'task', 'reopen', 'acme/'], connect)

  expect(run).toEqual({ code: 0, stdout: 'acme/app#12:Ship it\n', stderr: '' })
  expect(reopen.stdout).toBe('acme/app#1:Shipped\n')
})

test('__complete lists both the open and the closed Tasks for the ref of show', async () => {
  const show = await monica(['__complete', '--', 'task', 'show', 'acme/'], backendWithTasks())

  expect(show.stdout).toBe('acme/app#12:Ship it\nacme/app#1:Shipped\n')
})

test('__complete lists nothing without a Backend, when it fails, after the last argument, or for the value of a boolean option', async () => {
  const connect = backendWithTasks()
  const failing = { task: { list: () => Promise.reject(new Error('the Backend broke')) } }

  const noBackend = await monica(['__complete', '--', 'task', 'run', ''], () => null)
  const failed = await monica(
    ['__complete', '--', 'task', 'run', ''],
    () => failing as unknown as Client,
  )
  const afterRef = await monica(['__complete', '--', 'task', 'run', 'acme/app#12', ''], connect)
  const afterForce = await monica(['__complete', '--', 'task', 'close', '--force', ''], connect)

  expect(noBackend).toEqual({ code: 0, stdout: '', stderr: '' })
  expect(failed).toEqual({ code: 0, stdout: '', stderr: '' })
  expect(afterRef.stdout).toBe('')
  expect(afterForce.stdout).toBe('')
})

test('__complete lists nothing at once for a Backend that refuses connections, and gives up after 1 second on one that does not answer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'monica-'))
  onCleanup(() => rmSync(home, { recursive: true, force: true }))
  const writeEndpoint = (port: number) =>
    writeFileSync(
      join(home, 'backend.json'),
      JSON.stringify({ port, token: 'token', pid: process.pid }),
    )
  const complete = async () => {
    let stdout = ''
    await runCli(['__complete', '--', 'task', 'run', ''], {
      connect: (options) => connectTo(home, options),
      stdout: (text) => (stdout += text),
      stderr: () => {},
    })
    return stdout
  }
  const sleep = Bun.sleep
  const retries: unknown[] = []
  const spy = spyOn(Bun, 'sleep').mockImplementation(async (ms) => {
    if (ms === 200) retries.push(ms)
    return sleep(ms)
  })
  onCleanup(() => spy.mockRestore())

  const refusing = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const refusedPort = refusing.port!
  void refusing.stop(true)
  writeEndpoint(refusedPort)
  expect(await complete()).toBe('')
  expect(retries).toEqual([])

  const silent = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  })
  onCleanup(() => void silent.stop(true))
  writeEndpoint(silent.port!)
  const startedAt = performance.now()
  expect(await complete()).toBe('')
  expect(performance.now() - startedAt).toBeLessThan(1500)
})

test('completions zsh prints a script that asks the monica typed for the candidates', async () => {
  const script = await monica(['completions', 'zsh'], () => null)
  const shells = await monica(['__complete', '--', 'completions', ''], () => null)

  expect(script.code).toBe(0)
  expect(script.stdout).toStartWith('#compdef monica\n')
  expect(script.stdout).toContain('"${words[1]}" __complete -- "${(@)words[2,CURRENT]}"')
  expect(shells.stdout).toBe('zsh\n')
})

test('every completer names an argument of a CLI command, as the completion looks it up', () => {
  const { program } = createProgram([], { connect: () => null, stdout() {}, stderr() {} })
  const paths = leafPaths(completers)
  const misplaced = paths.filter((path) => {
    const names = path.map((key) => kebabCase(key))
    const command = names
      .slice(0, -1)
      .reduce<Command | undefined>(
        (parent, name) => parent?.commands.find((c) => c.name() === name),
        program,
      )
    return !command?.registeredArguments.some((a) => a.name() === names.at(-1))
  })

  expect(paths.length).toBeGreaterThan(0)
  expect(misplaced.map((path) => path.join('.'))).toEqual([])
})

function leafPaths(node: unknown, path: string[] = []): string[][] {
  if (typeof node === 'function') return [path]
  return Object.entries(node as object).flatMap(([key, child]) => leafPaths(child, [...path, key]))
}

test('completions refuses a shell other than zsh with exit 1', async () => {
  const result = await monica(['completions', 'bash'], () => null)

  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toMatch(/^BAD_REQUEST: [^\n]*'bash'[^\n]*\n$/)
})
