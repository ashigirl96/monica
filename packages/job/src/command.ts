import { closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Subprocess } from 'bun'

import type { jobExecution } from './schema.ts'
import type { UserJob } from './user-job.ts'

type JobExecutionRow = typeof jobExecution.$inferSelect

export type Outcome = Pick<JobExecutionRow, 'exitCode' | 'error'> & {
  result: Exclude<NonNullable<JobExecutionRow['result']>, 'interrupted'>
}

const KILL_GRACE_MS = 2000
const TAIL_BYTES = 4096
const ERROR_CHARS = 200

export const logDirOf = (home: string, name: string) => join(home, 'logs/jobs', name)

export const logPathOf = (home: string, name: string, startedAt: Date) =>
  join(logDirOf(home, name), `${stamp(startedAt)}.log`)

/** spawn できなければ 1 行の理由を message に持つ Error で投げる。 */
export async function runCommand(
  { command, cwd, timeoutMs }: Pick<UserJob, 'command' | 'cwd' | 'timeoutMs'>,
  log: string,
  children: Set<Subprocess>,
): Promise<Outcome> {
  mkdirSync(dirname(log), { recursive: true })
  const output = openSync(log, 'a')
  let child: Subprocess
  try {
    // 自分の process group で起こし、timeout と Backend の終了で子孫ごと止める。
    child = Bun.spawn(['/bin/sh', '-c', command], {
      cwd,
      env: process.env,
      stdin: 'ignore',
      stdout: output,
      stderr: output,
      detached: true,
    })
  } catch (error) {
    throw new Error(`spawn failed: ${error instanceof Error ? error.message : error}`, {
      cause: error,
    })
  } finally {
    closeSync(output)
  }
  children.add(child)
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    const code = await Promise.race([child.exited, timedOut])
    clearTimeout(timer)
    if (code === null) {
      await stopGroup(child)
      return {
        result: 'timed_out',
        exitCode: child.exitCode,
        error: `timed out after ${timeoutMs / 1000}s`,
      }
    }
    if (code === 0) return { result: 'succeeded', exitCode: 0, error: null }
    const reason = child.signalCode ? `killed by ${child.signalCode}` : `exit ${code}`
    const last = lastLine(log)
    return {
      result: 'failed',
      exitCode: child.exitCode,
      error: last ? `${reason}: ${last}` : reason,
    }
  } finally {
    children.delete(child)
  }
}

export function killGroups(children: Set<Subprocess>) {
  for (const child of children) signalGroup(child.pid, 'SIGKILL')
}

// sh が先に抜けても、SIGTERM を受けて後始末をしている子孫には猶予を残す。
async function stopGroup(child: Subprocess) {
  signalGroup(child.pid, 'SIGTERM')
  const deadline = Date.now() + KILL_GRACE_MS
  while (Date.now() < deadline && signalGroup(child.pid, 0)) await Bun.sleep(50)
  signalGroup(child.pid, 'SIGKILL')
  await child.exited
}

/** group に誰か居れば true。 */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(-pid, signal)
  } catch {
    return false
  }
}

// log は大きくなりうるので末尾だけを読む。
function lastLine(log: string): string | null {
  const fd = openSync(log, 'r')
  try {
    const { size } = fstatSync(fd)
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const line = buffer
      .toString('utf8')
      .split('\n')
      .map((text) => text.trim())
      .findLast((text) => text !== '')
    if (!line) return null
    return line.length > ERROR_CHARS ? `${line.slice(0, ERROR_CHARS)}…` : line
  } finally {
    closeSync(fd)
  }
}

function stamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.` +
    pad(date.getMilliseconds(), 3)
  )
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}
