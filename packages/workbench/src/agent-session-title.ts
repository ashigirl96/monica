import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

import { z } from 'zod'

const TAIL_BYTES = 64 * 1024

// Claude Code が文書化していない行なので、形が変われば読めなくなる。
const AiTitle = z.object({ type: z.literal('ai-title'), aiTitle: z.string().min(1) })

// title が読めなくても通知は出したいので、どんな失敗も null にする。
export function readAgentSessionTitle(transcriptPath: string | null): string | null {
  if (!transcriptPath) return null
  try {
    const last = tailLines(transcriptPath).findLast((line) => line.includes('"type":"ai-title"'))
    if (!last) return null
    const parsed = AiTitle.safeParse(JSON.parse(last))
    return parsed.success ? parsed.data.aiTitle : null
  } catch {
    return null
  }
}

function tailLines(path: string): string[] {
  const fd = openSync(path, 'r')
  try {
    const { size } = fstatSync(fd)
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    const read = readSync(fd, buffer, 0, buffer.length, start)
    // 窓で切れた先頭の行は JSON として読めないので、窓の外の行と同じく title にならない。
    return buffer.subarray(0, read).toString('utf8').split('\n')
  } finally {
    closeSync(fd)
  }
}
