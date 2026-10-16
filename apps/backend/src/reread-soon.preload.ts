import { appendFileSync } from 'node:fs'

// 子の process の timer はテストから spy できないので、`bun --preload` で差し替え、30 秒の setTimeout を記録して縮める。
const log = process.env.MONICA_TEST_TIMEOUTS_LOG!
const setTimeoutOf = globalThis.setTimeout
globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
  if (ms !== 30_000) return setTimeoutOf(handler, ms, ...args)
  appendFileSync(log, `${ms}\n`)
  return setTimeoutOf(handler, 50, ...args)
}) as typeof setTimeout
