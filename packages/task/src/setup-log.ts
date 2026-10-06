import { type Dirent, existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import type { Db } from '@tania/workbench/server'
import { eq } from 'drizzle-orm'

import { messageOf, setupLogOf } from './prepare.ts'
import { bench, issue } from './schema.ts'

// ptyd の log（crates/logfile）の保持にそろえる。
const RETENTION_MS = 14 * 24 * 60 * 60_000

// 同期の fs で走らせ、Bench の有無と最後に書かれた時刻を見てから消すまでの間に、run が log を書き直す隙を作らない。
export function sweepSetupLogs({ db, home }: { db: Db; home: string }) {
  const root = join(home, 'logs/setup')
  if (!existsSync(root)) return
  const isBenchLog = benchLogMatcher(db, home)
  const cutoff = Date.now() - RETENTION_MS
  const failures: string[] = []
  function attempt<T>(step: () => T, otherwise: T): T {
    try {
      return step()
    } catch (error) {
      failures.push(messageOf(error))
      return otherwise
    }
  }
  for (const owner of attempt(() => directoriesIn(root), [])) {
    for (const repo of attempt(() => directoriesIn(owner), [])) {
      for (const log of attempt(() => filesIn(repo), [])) {
        if (isBenchLog(log)) continue
        attempt(() => {
          if (statSync(log).mtimeMs <= cutoff) unlinkSync(log)
        }, undefined)
      }
      attempt(() => removeIfEmpty(repo), undefined)
    }
    attempt(() => removeIfEmpty(owner), undefined)
  }
  if (failures.length > 0) {
    throw new Error(`could not remove the setup logs: ${failures.join('; ')}`)
  }
}

// repo の名前の大小だけを変えた改名の後も、macOS の file system では同じ log を指す。
function benchLogMatcher(db: Db, home: string): (log: string) => boolean {
  const logs = new Set(
    db
      .select({ repo: issue.repo, number: issue.number })
      .from(bench)
      .innerJoin(issue, eq(issue.id, bench.taskIssueId))
      .all()
      .map((ref) => setupLogOf(home, ref).toLowerCase()),
  )
  return (log) => logs.has(log.toLowerCase())
}

const directoriesIn = (path: string) => pathsIn(path, (entry) => entry.isDirectory())
const filesIn = (path: string) => pathsIn(path, (entry) => entry.isFile())

// 名前の順に見て、失敗の並びを毎回同じにする。
function pathsIn(path: string, keep: (entry: Dirent) => boolean): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter(keep)
    .map((entry) => join(path, entry.name))
    .toSorted()
}

function removeIfEmpty(directory: string) {
  if (readdirSync(directory).length === 0) rmdirSync(directory)
}
