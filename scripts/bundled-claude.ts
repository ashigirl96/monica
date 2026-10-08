import { createRequire } from 'node:module'
import { join } from 'node:path'

// bun の isolated linker では SDK を packages/chat からしか解けず、platform package は SDK の場所からしか解けない。
// SDK も自分の場所から同じ名前を解くので、dev の Backend が使う claude と同じ file になる（ADR-0032）。
export function bundledClaude(): string {
  const sdk = Bun.resolveSync(
    '@anthropic-ai/claude-agent-sdk',
    join(import.meta.dir, '../packages/chat'),
  )
  return createRequire(sdk).resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
  )
}
