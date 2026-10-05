import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'
import { bench, issue, issueBlocker, run, task } from '@tania/task/schema'
import type { Ghq } from '@tania/task/server'

import {
  backendWithTasks,
  cleanUp,
  inMemoryBackend,
  openTabOutsideBench,
  tania,
} from './testing.ts'

test('task list prints the open Tasks as text', async () => {
  const result = await tania(['task', 'list'], backendWithTasks())

  expect(result).toEqual({
    code: 0,
    stdout:
      'REF          TITLE    STATE        BLOCKED BY  CWD\n' +
      'acme/app#12  Ship it  not_started  acme/lib#3  -\n',
    stderr: '',
  })
})

test('task list --closed prints only the closed Tasks', async () => {
  const result = await tania(['task', 'list', '--closed'], backendWithTasks())

  expect(result.code).toBe(0)
  expect(result.stdout).toContain('acme/app#1 ')
  expect(result.stdout).not.toContain('acme/app#12')
})

test('task list --format json prints the procedure output as it is', async () => {
  const result = await tania(['task', 'list', '--format', 'json'], backendWithTasks())

  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    tasks: [
      {
        ref: 'acme/app#12',
        title: 'Ship it',
        issueState: 'open',
        blockers: ['acme/lib#3'],
        cwd: null,
        displayState: { state: 'not_started' },
      },
    ],
    backgroundSyncError: null,
  })
})

test('task track takes the ref as an argument and refuses a bare #n with exit 1', async () => {
  const result = await tania(['task', 'track', '#12'], backendWithTasks())

  expect(result.code).toBe(1)
  expect(result.stderr).toMatch(/^BAD_REQUEST: "#12" is not owner\/repo#n[^\n]*\n$/)
})

test('task track exits 1 when GitHub cannot be reached', async () => {
  const result = await tania(['task', 'track', 'acme/app#99'], backendWithTasks())

  expect(result.code).toBe(1)
  expect(result.stderr).toMatch(/^BAD_GATEWAY: could not sync from GitHub: `gh auth token`/)
})

test('task sync takes an optional ref and exits 1 for one that is not tracked', async () => {
  const result = await tania(['task', 'sync', 'acme/app#99'], backendWithTasks())

  expect(result).toEqual({
    code: 1,
    stdout: '',
    stderr: 'NOT_FOUND: acme/app#99 is not tracked\n',
  })
})

function backendWithBench({ home, ghq }: { home?: string; ghq?: Ghq } = {}) {
  const backend = inMemoryBackend({ home, ghq })
  const { db } = backend
  const tracked = db
    .insert(issue)
    .values({
      repo: 'acme/app',
      number: 12,
      title: 'Ship it',
      state: 'open',
      syncedAt: new Date(),
    })
    .returning()
    .get()
  db.insert(task)
    .values({ issueId: tracked.id, trackedAt: new Date(1) })
    .run()
  const client = createRouterClient(backend.router, { context: backend.context })
  return { ...backend, issueId: tracked.id, connect: () => client }
}

function inScratch() {
  const scratch = mkdtempSync(join(tmpdir(), 'tania-cli-'))
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }))
  return scratch
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  cleanUp()
})

function inPlaceBench() {
  const scratch = inScratch()
  const checkout = join(scratch, 'github.com/acme/app')
  mkdirSync(checkout, { recursive: true })
  const backend = backendWithBench({
    home: scratch,
    ghq: { root: () => Promise.resolve(scratch), get: () => Promise.resolve() },
  })
  return { ...backend, checkout }
}

test('task run prints where the Bench is, that claude started, and that GitHub could not be reached', async () => {
  const { connect, checkout } = inPlaceBench()

  const result = await tania(['task', 'run', 'acme/app#12', '--in-place'], connect)

  expect(result).toEqual({
    code: 0,
    stdout:
      `opened the Bench of acme/app#12 at ${checkout}\n` +
      'started claude in a new Tab\n' +
      'warning: could not sync acme/app#12 from GitHub (`gh auth token` failed: not logged in); using the copy from 0 minutes ago\n',
    stderr: '',
  })
})

test('task run exits 1 naming the open Blockers, and --force starts claude past them', async () => {
  const { db, issueId, connect } = inPlaceBench()
  const upstream = db
    .insert(issue)
    .values({
      repo: 'acme/lib',
      number: 3,
      title: 'Upstream fix',
      state: 'open',
      syncedAt: new Date(),
    })
    .returning()
    .get()
  db.insert(issueBlocker).values({ issueId, blockerId: upstream.id }).run()

  const blocked = await tania(['task', 'run', 'acme/app#12', '--in-place'], connect)
  const forced = await tania(['task', 'run', 'acme/app#12', '--in-place', '--force'], connect)

  expect(blocked).toEqual({
    code: 1,
    stdout: '',
    stderr: 'BLOCKED: acme/app#12 is blocked by acme/lib#3; pass --force to start a Run anyway\n',
  })
  expect(forced.code).toBe(0)
  expect(forced.stdout).toContain('started claude in a new Tab\n')
})

test('task run exits 1 with the reason and the log path when the Bench cannot be prepared', async () => {
  const home = inScratch()
  const { connect } = backendWithBench({ home })

  const result = await tania(['task', 'run', 'acme/app#12'], connect)

  expect(result).toEqual({
    code: 1,
    stdout: '',
    stderr:
      'PRECONDITION_FAILED: could not prepare the Bench of acme/app#12: ghq root failed: no ghq in the CLI tests; ' +
      `see ${home}/logs/setup/acme/app/issue-12.log\n`,
  })
})

test("task run --in-place exits 1 when it cannot find the Repo's checkout", async () => {
  const { connect } = backendWithBench()

  const result = await tania(['task', 'run', 'acme/app#12', '--in-place'], connect)

  expect(result).toEqual({
    code: 1,
    stdout: '',
    stderr:
      'PRECONDITION_FAILED: could not find the checkout of acme/app#12: ghq root failed: no ghq in the CLI tests\n',
  })
})

test('task current names the Task of the Bench the Tab is in, given by TANIA_TERMINAL_SESSION_ID', async () => {
  const { db, issueId, context, connect } = backendWithBench()
  const runspaceId = db.transaction((tx) => {
    const id = context.workbench.createRunspace(tx, { cwd: '/work' })
    tx.insert(bench)
      .values({
        taskIssueId: issueId,
        runspaceId: id,
        cwd: '/work',
        mode: 'in_place',
        setupState: 'ready',
        createdAt: new Date(0),
      })
      .run()
    return id
  })
  const { terminalSessionId } = await connect().workbench.tab.open({
    runspaceId,
    rows: 24,
    cols: 80,
  })

  const result = await tania(['task', 'current'], connect, { terminalSessionId })

  expect(result).toEqual({
    code: 0,
    stdout: 'REF          TITLE    STATE\nacme/app#12  Ship it  ended\n',
    stderr: '',
  })
})

test('task attach moves the Tab given by TANIA_TERMINAL_SESSION_ID into the Bench, opening it in place', async () => {
  const { connect } = inPlaceBench()
  const terminalSessionId = await openTabOutsideBench(connect())

  const result = await tania(['task', 'attach', 'acme/app#12'], connect, { terminalSessionId })

  expect(result).toEqual({
    code: 0,
    stdout:
      'opened the Bench of acme/app#12 in place\n' +
      'this Tab is in the Bench of acme/app#12 Ship it\n' +
      'no claude runs in this Tab; the one you start here becomes a Run of acme/app#12\n',
    stderr: '',
  })
})

async function withLiveRun({ db, issueId, connect }: ReturnType<typeof backendWithBench>) {
  const terminalSessionId = await openTabOutsideBench(connect())
  await connect().workbench.agentSession.recordHook({
    terminalSessionId,
    payload: { session_id: 's-1', cwd: '/work', hook_event_name: 'UserPromptSubmit', prompt: 'go' },
  })
  db.insert(run)
    .values({
      taskIssueId: issueId,
      agentSessionId: 's-1',
      origin: 'started',
      startedAt: new Date(0),
    })
    .run()
  return terminalSessionId
}

test('task close exits 1 with each reason on its own line after the code, and --force closes past them', async () => {
  const backend = backendWithBench()
  await withLiveRun(backend)

  const refused = await tania(['task', 'close', 'acme/app#12'], backend.connect)
  const forced = await tania(['task', 'close', 'acme/app#12', '--force'], backend.connect)

  expect(refused).toEqual({
    code: 1,
    stdout: '',
    stderr:
      'CLOSE_REFUSED: acme/app#12 stays open:\n' +
      'claude s-1 is a live Run (running)\n' +
      'pass --force to close anyway\n',
  })
  expect(forced).toEqual({
    code: 0,
    stdout:
      'closed acme/app#12\n' +
      'warning: could not sync acme/app#12 from GitHub (`gh auth token` failed: not logged in); using the copy from 0 minutes ago\n',
    stderr: '',
  })
})

test('task close in the Tab of a live Run is not stopped by that Run, and task reopen opens the Task again', async () => {
  const backend = backendWithBench()
  const terminalSessionId = await withLiveRun(backend)

  const closed = await tania(['task', 'close', 'acme/app#12'], backend.connect, {
    terminalSessionId,
  })
  const reopened = await tania(['task', 'reopen', 'acme/app#12'], backend.connect)

  expect(closed.code).toBe(0)
  expect(reopened.code).toBe(0)
  expect(reopened.stdout).toStartWith('reopened acme/app#12 Ship it\n')
})

test('task current exits 1 outside a Tab, and takes no flag for the Terminal Session', async () => {
  const { connect } = backendWithBench()

  const outside = await tania(['task', 'current'], connect)
  const flagged = await tania(['task', 'current', '--terminal-session-id', 'ts-a'], connect)

  expect(outside.code).toBe(1)
  expect(outside.stderr).toStartWith('BAD_REQUEST: not in a Tab of the Workbench')
  expect(flagged.code).toBe(1)
  expect(flagged.stderr).toMatch(/^BAD_REQUEST: unknown option '--terminal-session-id'/)
})
