import { appendFileSync } from 'node:fs'

// 子の process の timer はテストから spy できないので、`bun --preload` で差し替え、受けた ms を記録してすぐ打ち切る。
const log = process.env.MONICA_TEST_TIMEOUTS_LOG!
AbortSignal.timeout = (ms: number) => {
  appendFileSync(log, `${ms}\n`)
  return AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'))
}
