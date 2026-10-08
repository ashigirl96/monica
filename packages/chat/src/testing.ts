import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// claude の env には PATH が無く、SDK は .ts の path を bun の名前で起こすので、拡張子の無い wrapper から絶対 path で起こす。
export function writeFakeClaude(dir: string, recordPath: string): string {
  writeFileSync(recordPath, '')
  const claudePath = join(dir, 'claude')
  writeFileSync(
    claudePath,
    `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'fake-claude.ts')}" "${recordPath}" "$@"\n`,
  )
  chmodSync(claudePath, 0o755)
  return claudePath
}
