import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 偽の claude の場面。answer のほかは、research で本物の claude が流した失敗の並びを真似る。 */
export type FakeScenario =
  | 'answer'
  | 'usage-warning'
  | 'not-logged-in'
  | 'usage-limit'
  | 'throttled'
  | 'overloaded'
  | 'billing'
  | 'max-output-tokens'
  | 'exit-at-start'
  | 'exit-mid-answer'
  | 'restart'
  | 'unstreamed'

/** 偽の claude の rate_limit_event が持つ resetsAt（unix 秒）。 */
export const FAKE_RESETS_AT = 1_800_000_000

// claude の env には PATH が無く、SDK は .ts の path を bun の名前で起こすので、拡張子の無い wrapper から絶対 path で起こす。
export function writeFakeClaude(
  dir: string,
  recordPath: string,
  scenario: FakeScenario = 'answer',
): string {
  writeFileSync(recordPath, '')
  const claudePath = join(dir, 'claude')
  writeFileSync(
    claudePath,
    `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'fake-claude.ts')}" "${recordPath}" ${scenario} "$@"\n`,
  )
  chmodSync(claudePath, 0o755)
  return claudePath
}
