import { afterAll, afterEach } from 'bun:test'
import { appendFileSync } from 'node:fs'

// `--parallel` は test file ごとにこの module を評価し直し、`Bun.main` はその test file になる。
// 開始は評価の時点で書き、test file の import や top level で止まったものも終わっていない file に数える。
const progress = process.env.MONICA_TEST_PROGRESS
if (progress) {
  const write = (event: string) => appendFileSync(progress, `${event} ${Bun.main}\n`)
  write('start')
  afterEach(() => write('test'))
  afterAll(() => write('end'))
}
