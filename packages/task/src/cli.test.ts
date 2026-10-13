import { expect, test } from 'bun:test'

import { formatters } from './cli.ts'
import type { ListItem, RunItem } from './contract.ts'

const item = (overrides: Partial<ListItem>): ListItem => ({
  ref: 'acme/app#12',
  title: 'Ship it',
  issueState: 'open',
  blockers: [],
  cwd: null,
  displayState: { state: 'not_started' },
  ...overrides,
})

test('sync counts the synced Tasks and names the missing Issues', () => {
  expect(formatters.sync({ synced: 1, missing: [] })).toBe('synced 1 Task')
  expect(formatters.sync({ synced: 2, missing: ['acme/app#3', 'acme/lib#4'] })).toBe(
    'synced 2 Tasks\nGitHub did not return acme/app#3, acme/lib#4; their copies are kept',
  )
})

test('list prints a table with Blockers in the same repo as #n', () => {
  const text = formatters.list({
    tasks: [
      item({ blockers: ['acme/app#4', 'Acme/Lib#3'] }),
      item({ ref: 'acme/lib#7', title: 'Fix', displayState: { state: 'issue_closed' } }),
    ],
    backgroundSyncError: null,
  })

  expect(text).toBe(
    [
      'REF          TITLE    STATE         BLOCKED BY      CWD',
      'acme/app#12  Ship it  not_started   #4, Acme/Lib#3  -',
      'acme/lib#7   Fix      issue_closed  -               -',
    ].join('\n'),
  )
})

test('list ends with a warning when the last background sync failed', () => {
  const text = formatters.list({
    tasks: [],
    backgroundSyncError: { at: new Date(Date.UTC(2026, 9, 4, 3, 0)), message: 'acme/app: 502' },
  })

  expect(text).toBe(
    'No Tasks\nwarning: the background sync failed at 2026-10-04T03:00:00.000Z: acme/app: 502',
  )
})

test('list counts a wide character as two columns', () => {
  const text = formatters.list({
    tasks: [item({ title: '写しと sync' }), item({ ref: 'acme/app#3', title: 'Fix' })],
    backgroundSyncError: null,
  })

  expect(text).toBe(
    [
      'REF          TITLE        STATE        BLOCKED BY  CWD',
      'acme/app#12  写しと sync  not_started  -           -',
      'acme/app#3   Fix          not_started  -           -',
    ].join('\n'),
  )
})

const ago = (ms: number) => new Date(Date.now() - ms)
const liveRun = (agentSessionId: string) => ({
  agentSessionId,
  state: 'running' as const,
  since: ago(0),
})

test('list writes the state of a Task with live Runs with its reason, tool, age and other live Runs', () => {
  const text = formatters.list({
    tasks: [
      item({
        displayState: {
          state: 'waiting',
          reason: 'permission',
          tool: 'Bash',
          since: ago(12 * 60_000),
          liveRuns: [liveRun('s-1'), liveRun('s-2')],
        },
      }),
      item({
        ref: 'acme/app#3',
        displayState: {
          state: 'waiting',
          reason: 'error',
          errorType: 'rate_limit',
          since: ago(3 * 60_000),
          liveRuns: [liveRun('s-3')],
        },
      }),
      item({
        ref: 'acme/app#4',
        displayState: { state: 'running', since: ago(30_000), liveRuns: [liveRun('s-4')] },
      }),
      item({
        ref: 'acme/app#5',
        displayState: {
          state: 'unobserved',
          since: ago(5 * 3_600_000),
          liveRuns: [liveRun('s-5'), liveRun('s-6'), liveRun('s-7')],
        },
      }),
      item({
        ref: 'acme/app#6',
        displayState: {
          state: 'waiting',
          reason: 'idle',
          since: ago(2 * 86_400_000),
          liveRuns: [],
        },
      }),
    ],
    backgroundSyncError: null,
  })

  expect(text.split('\n').map((line) => line.split(/ {2,}/)[2])).toEqual([
    'STATE',
    'waiting:permission(Bash) 12m +1',
    'waiting:error 3m',
    'running 30s',
    'unobserved 5h +2',
    'waiting:idle 2d',
  ])
})

test('run says first that it tracked the Issue only when it did', () => {
  const output = {
    ref: 'acme/app#12',
    title: 'Ship it',
    tracked: true,
    cwd: '/home/worktrees/acme/app/issue-12',
    mode: 'worktree' as const,
    benchCreated: true,
    warnings: [],
    tabId: 't-1',
    terminalSessionId: 'ts-1',
    resumed: null,
  }

  expect(formatters.run(output)).toBe(
    [
      'tracked acme/app#12 (Ship it)',
      'opened the Bench of acme/app#12 at /home/worktrees/acme/app/issue-12',
      'started claude in a new Tab',
    ].join('\n'),
  )
  expect(formatters.run({ ...output, tracked: false })).toBe(
    [
      'opened the Bench of acme/app#12 at /home/worktrees/acme/app/issue-12',
      'started claude in a new Tab',
    ].join('\n'),
  )
})

test('attach names the claude of the Tab and whether attach made it a Run', () => {
  const output = {
    ref: 'acme/app#12',
    title: 'Ship it',
    tracked: false,
    benchCreated: false,
    runCreated: true,
    agentSessionId: 's-1',
  }

  expect(formatters.attach(output)).toBe(
    'this Tab is in the Bench of acme/app#12 Ship it\nclaude s-1 is now a Run of acme/app#12',
  )
  expect(formatters.attach({ ...output, runCreated: false })).toBe(
    'this Tab is in the Bench of acme/app#12 Ship it\nclaude s-1 is a Run of acme/app#12',
  )
})

test('attach says first that it tracked the Issue only when it did', () => {
  const output = {
    ref: 'acme/app#12',
    title: 'Ship it',
    tracked: true,
    benchCreated: true,
    runCreated: false,
    agentSessionId: null,
  }

  expect(formatters.attach(output)).toBe(
    [
      'tracked acme/app#12 (Ship it)',
      'opened the Bench of acme/app#12 in place',
      'this Tab is in the Bench of acme/app#12 Ship it',
      'no claude runs in this Tab; the one you start here becomes a Run of acme/app#12',
    ].join('\n'),
  )
  expect(formatters.attach({ ...output, tracked: false }).split('\n')[0]).toBe(
    'opened the Bench of acme/app#12 in place',
  )
})

test('close names what it took down, whether the Tab stayed, and the warnings', () => {
  const output = {
    ref: 'acme/app#12',
    removedWorktree: '/home/worktrees/acme/app/issue-12',
    deletedBranch: 'issue-12',
    spared: true,
    warnings: ['could not sync acme/app#12 from GitHub'],
  }

  expect(formatters.close(output)).toBe(
    [
      'closed acme/app#12',
      'removed the worktree /home/worktrees/acme/app/issue-12',
      'deleted the branch issue-12',
      'this Tab stays, in a Runspace that is no longer a Bench',
      'warning: could not sync acme/app#12 from GitHub',
    ].join('\n'),
  )
  expect(
    formatters.close({
      ...output,
      removedWorktree: null,
      deletedBranch: null,
      spared: false,
      warnings: [],
    }),
  ).toBe('closed acme/app#12')
})

test('reopen names the Task and the warnings', () => {
  expect(formatters.reopen({ ref: 'acme/app#12', title: 'Ship it', warnings: [] })).toBe(
    'reopened acme/app#12 Ship it',
  )
  expect(formatters.reopen({ ref: 'acme/app#12', title: 'Ship it', warnings: ['offline'] })).toBe(
    'reopened acme/app#12 Ship it\nwarning: offline',
  )
})

test('current writes the state the same way as list', () => {
  const text = formatters.current({
    ref: 'acme/app#12',
    title: 'Ship it',
    displayState: {
      state: 'waiting',
      reason: 'question',
      since: ago(60_000),
      liveRuns: [liveRun('s-1')],
    },
    agentSessionId: 's-1',
    source: 'run',
  })

  expect(text).toBe(
    ['REF          TITLE    STATE', 'acme/app#12  Ship it  waiting:question 1m'].join('\n'),
  )
})

const runItem = (overrides: Partial<RunItem>): RunItem => ({
  agentSessionId: 's-1',
  state: 'ended',
  origin: 'started',
  startedAt: new Date(Date.UTC(2026, 9, 13, 9, 1, 0)),
  lastEventAt: new Date(Date.UTC(2026, 9, 13, 9, 2, 0)),
  endedAt: new Date(Date.UTC(2026, 9, 13, 9, 2, 0)),
  cwd: '/work/app',
  transcriptPath: null,
  resumable: true,
  ...overrides,
})

test('show heads the table with the Task and marks a Run whose transcript is gone', () => {
  const text = formatters.show({
    ref: 'acme/app#12',
    title: 'Ship it',
    closedAt: null,
    runs: [
      runItem({ agentSessionId: 's-live', state: 'running', origin: 'attached', endedAt: null }),
      runItem({ agentSessionId: 's-gone', transcriptPath: '/gone.jsonl', resumable: false }),
    ],
  })

  expect(text).toBe(
    [
      'acme/app#12 Ship it',
      '',
      'SESSION ID                STATE    ORIGIN    STARTED              LAST EVENT           CWD',
      's-live                    running  attached  2026-10-13 09:01:00  2026-10-13 09:02:00  /work/app',
      's-gone (transcript gone)  ended    started   2026-10-13 09:01:00  2026-10-13 09:02:00  /work/app',
    ].join('\n'),
  )
})

test('show says when a closed Task was closed and when it has no Runs', () => {
  const text = formatters.show({
    ref: 'acme/app#12',
    title: 'Ship it',
    closedAt: new Date(Date.UTC(2026, 9, 13, 9, 3, 0)),
    runs: [],
  })

  expect(text).toBe(
    ['acme/app#12 Ship it', 'closed at 2026-10-13 09:03:00', '', 'No Runs'].join('\n'),
  )
})
