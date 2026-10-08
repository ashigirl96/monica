import binPath from '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude' with { type: 'file' }
import { extractFromBunfs } from '@anthropic-ai/claude-agent-sdk/extract'

import { main } from './probe-core.ts'

const rssKB = () => Math.round(process.memoryUsage().rss / 1024)
const rssBeforeExtractKB = rssKB()
const t0 = performance.now()
const claudePath = extractFromBunfs(binPath)
const extractMs = Math.round(performance.now() - t0)
const rssAfterExtractKB = rssKB()
Bun.gc(true)
await main(claudePath, {
  embeddedPath: binPath,
  extractMs,
  rssBeforeExtractKB,
  rssAfterExtractKB,
  rssAfterGcKB: rssKB(),
})
