import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type FakeScenario =
  | 'answer'
  | 'not-logged-in'
  | 'max-output-tokens'
  | 'exit-at-start'
  | 'exit-mid-answer'
  | 'slow-initialize'
  | 'linger-after-answer'
  | 'exit-leaving-stderr-open'

/** 偽の claude が initialize の応答で返す model の一覧。SDK の ModelInfo の形。 */
export const FAKE_MODELS = [
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-5-5',
    displayName: 'Haiku 5.5',
    description: 'Fastest for quick answers',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
  },
  {
    value: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku 4.5',
    description: 'Haiku 4.5',
  },
]

/**
 * dir に書いた偽の claude（wrapper の sh と、exec した後の bun）が、すべて居なくなるまで待つ。
 * 居るうちに dir を消すと、Bun の rmSync は走査の途中で黙って止まり、dir を残す。
 */
export async function untilFakeClaudesExit(dir: string): Promise<void> {
  for (;;) {
    const ps = Bun.spawnSync(['/bin/ps', '-A', '-ww', '-o', 'stat=,command='], { env: {} })
    const alive = ps.stdout
      .toString()
      .split('\n')
      .some((line) => line.includes(dir) && !line.trim().startsWith('Z'))
    if (!alive) return
    await Bun.sleep(10)
  }
}

// claude の env には PATH が無く、SDK は .ts の path を bun の名前で起こすので、拡張子の無い wrapper から絶対 path で起こす。
// macOS は新しく書いた実行 file を初めて exec するたびに検査を挟むので、wrapper は repo の 1 つを symlink で指し、起こし方は隣の file に書く。
export function writeFakeClaude(
  dir: string,
  recordPath: string,
  scenario: FakeScenario = 'answer',
): string {
  writeFileSync(recordPath, '')
  const claudePath = join(dir, 'claude')
  const args = [process.execPath, join(import.meta.dir, 'fake-claude.ts'), recordPath, scenario]
  writeFileSync(`${claudePath}.args`, `${args.join('\n')}\n`)
  rmSync(claudePath, { force: true })
  symlinkSync(join(import.meta.dir, 'fake-claude.sh'), claudePath)
  return claudePath
}
