import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'

import { ORPCError } from '@orpc/server'
import { Cron } from 'croner'

import type { job } from './schema.ts'

export type UserJob = typeof job.$inferSelect

const DEFAULT_TIMEOUT = '1h'
// Bun は 2^31 ms（約 24.8 日）を超える setTimeout の遅延を 1 ms に丸めるので上限が要り、1 日を超えて走る Job は想定しない。
const MAX_TIMEOUT_MS = 24 * 3_600_000

const UNIT_MS: Partial<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000 }

export function cronOf(expression: string): Cron {
  return new Cron(expression, { mode: '5-part' })
}

export function parseSchedule(expression: string): Cron {
  let cron: Cron
  try {
    cron = cronOf(expression)
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown)
    throw new ORPCError('BAD_REQUEST', {
      message: `could not read the schedule ${expression}: ${reason}`,
    })
  }
  if (!cron.nextRun()) {
    throw new ORPCError('BAD_REQUEST', { message: `the schedule ${expression} never comes` })
  }
  return cron
}

// CLI と Backend は cwd が違うので、相対 path は受けない。
export function parseCwd(cwd = homedir()): string {
  if (!isAbsolute(cwd)) {
    throw new ORPCError('BAD_REQUEST', { message: `the cwd ${cwd} is not an absolute path` })
  }
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ORPCError('BAD_REQUEST', { message: `the cwd ${cwd} is not a directory` })
  }
  return cwd
}

export function parseTimeout(timeout = DEFAULT_TIMEOUT): number {
  const unitMs = /^[1-9]\d*[smh]$/.test(timeout) ? UNIT_MS[timeout.slice(-1)] : undefined
  if (unitMs === undefined) {
    throw new ORPCError('BAD_REQUEST', {
      message: `the timeout ${timeout} is not a number and s, m or h, such as 30m or 2h`,
    })
  }
  const ms = Number(timeout.slice(0, -1)) * unitMs
  if (ms > MAX_TIMEOUT_MS) {
    throw new ORPCError('BAD_REQUEST', { message: `the timeout ${timeout} is longer than 24h` })
  }
  return ms
}
