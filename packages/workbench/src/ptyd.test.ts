import { afterEach, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'

import { startFakePtyd, tempHome } from './fake-ptyd.ts'
import { inheritableEnv, openDaemon } from './ptyd.ts'
import { cleanUp, onCleanup } from './testing.ts'

afterEach(cleanUp)

test('a cwd whose multibyte character straddles two socket chunks is read intact', async () => {
  const home = tempHome(onCleanup)
  const ptyd = startFakePtyd(home)
  onCleanup(() => ptyd.stop())
  ptyd.sessions.push({
    session_id: 'ts-a',
    running: true,
    attached: false,
    pid: 4242,
    exit_code: null,
    cwd: '/work/日本語',
    rows: 24,
    cols: 80,
  })
  ptyd.splitListMidCharacter = true
  const opened = await openDaemon(
    { home, ptydPath: join(home, 'no-ptyd') },
    { onExit: () => {}, onClose: () => {} },
  )
  onCleanup(() => opened.close())

  expect((await opened.list()).map((s) => s.cwd)).toEqual(['/work/日本語'])
})

test('a processes request that an older ptyd leaves unanswered is unknown after 2 seconds and no longer awaited', async () => {
  const realSetTimeout = globalThis.setTimeout
  let fireTimeout: (() => void) | undefined
  const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms?: number,
  ) => {
    if (ms !== 2000) return realSetTimeout(callback, ms)
    fireTimeout = callback
    return realSetTimeout(() => {}, 0)
  }) as typeof setTimeout)
  onCleanup(() => spy.mockRestore())
  const home = tempHome(onCleanup)
  const ptyd = startFakePtyd(home)
  onCleanup(() => ptyd.stop())
  ptyd.holdNext('processes')
  const opened = await openDaemon(
    { home, ptydPath: join(home, 'no-ptyd') },
    { onExit: () => {}, onClose: () => {} },
  )
  onCleanup(() => opened.close())

  const processes = opened.processes('ts-a')
  await ptyd.received((op) => op.op === 'processes')
  fireTimeout!()

  expect(await processes).toEqual({ kind: 'unknown' })
  expect(opened['pending'].size).toBe(0)
})

test("the env passed on to ptyd and setup drops the Backend's MONICA_*, CLAUDECODE and CLAUDE_CODE_* and keeps the rest", () => {
  const backendEnv = {
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    MONICA_TERMINAL_SESSION_ID: 'ts-backend',
    MONICA_HOME: '/backend/home',
    UNRELATED_TO_MONICA: 'kept',
  }
  const saved = Object.keys(backendEnv).map((key) => [key, process.env[key]] as const)
  onCleanup(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  Object.assign(process.env, backendEnv)

  const env = inheritableEnv()

  expect(Object.keys(env)).not.toContainAnyValues([
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'MONICA_TERMINAL_SESSION_ID',
    'MONICA_HOME',
  ])
  expect(env.UNRELATED_TO_MONICA).toBe('kept')
})
