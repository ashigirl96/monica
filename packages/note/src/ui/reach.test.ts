import { afterEach, expect, mock, setSystemTime, spyOn, test } from 'bun:test'

import { Reach } from './reach.ts'

const t0 = new Date(2026, 9, 6, 12)

afterEach(() => {
  setSystemTime()
  mock.restore()
})

function at(ms: number) {
  setSystemTime(new Date(t0.getTime() + ms))
}

// 確かめの request の timer を手で進める。
function captureTimers() {
  const timers: { run: () => void; ms: number | undefined }[] = []
  spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, ms?: number) => {
    timers.push({ run, ms })
    return timers.length as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
  spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
  return timers
}

function setup() {
  const timers = captureTimers()
  const reach = new Reach()
  const probe = mock(() => Promise.resolve())
  reach.watch(probe)
  const changes = mock(() => {})
  reach.subscribe(changes)
  return { reach, timers, probe, changes }
}

test('a failure answered within a second shows no notice', () => {
  const { reach, changes } = setup()

  at(0)
  reach.failed()
  at(999)
  reach.failed()
  at(1500)
  reach.reached()

  expect(reach.isUnreachable()).toBe(false)
  expect(changes).not.toHaveBeenCalled()
})

test('a failure starts a probe each second, and a probe still failing a second on shows the notice', () => {
  const { reach, timers, probe, changes } = setup()

  at(0)
  reach.failed()
  expect(timers.map((t) => t.ms)).toEqual([1000])

  at(1000)
  timers[0]!.run()
  expect(probe).toHaveBeenCalledTimes(1)
  reach.failed()

  expect(reach.isUnreachable()).toBe(true)
  expect(changes).toHaveBeenCalledTimes(1)
  expect(timers.map((t) => t.ms)).toEqual([1000, 1000])
})

test('the first answer after the notice hides it and stops the probes', () => {
  const { reach, timers, probe, changes } = setup()
  at(0)
  reach.failed()
  at(1000)
  timers[0]!.run()
  reach.failed()

  at(1200)
  reach.reached()

  expect(reach.isUnreachable()).toBe(false)
  expect(changes).toHaveBeenCalledTimes(2)
  timers[1]!.run()
  expect(probe).toHaveBeenCalledTimes(1)
})

test('a failure after the Backend came back counts its second from that failure', () => {
  const { reach } = setup()
  at(0)
  reach.failed()
  at(500)
  reach.reached()

  at(1200)
  reach.failed()
  at(2100)
  reach.failed()

  expect(reach.isUnreachable()).toBe(false)
})
