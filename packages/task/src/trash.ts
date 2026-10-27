import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { messageOf } from './prepare.ts'

// Terminate の後に残った process が止まる 7 秒（ADR-0040）と close の応答より長くとる。
const GRACE_MS = 60_000

export const trashOf = (home: string) => join(home, 'trash/worktrees')

export const treeOf = (trashed: string) => join(trashed, 'tree')
const markOf = (trashed: string) => join(trashed, 'restore-to')

/** 捨て場の `<uuid>/` を返す。移せなければ何も残さず null を返す。 */
export function moveAside(path: string, trash: string, { mark }: { mark: boolean }): string | null {
  const trashed = join(trash, randomUUID())
  try {
    mkdirSync(trashed, { recursive: true })
    if (mark) writeFileSync(markOf(trashed), `${path}\n`)
    renameSync(path, treeOf(trashed))
    return trashed
  } catch {
    rmSync(trashed, { recursive: true, force: true })
    return null
  }
}

export function putBack(trashed: string, path: string) {
  renameSync(treeOf(trashed), path)
  rmSync(trashed, { recursive: true, force: true })
}

export const unmark = (trashed: string) => unlinkSync(markOf(trashed))

/** guard を通る前に Backend が落ちた worktree を元の path へ戻す。戻す先が塞がっていれば印ごと残す。 */
export function restoreTrashedWorktrees(trash: string) {
  for (const trashed of entriesOf(trash)) {
    try {
      if (!existsSync(markOf(trashed))) continue
      if (!existsSync(treeOf(trashed))) {
        rmSync(trashed, { recursive: true, force: true })
        continue
      }
      const path = readFileSync(markOf(trashed), 'utf8').trimEnd()
      mkdirSync(dirname(path), { recursive: true })
      putBack(trashed, path)
    } catch (error) {
      console.error(`[task] could not put the worktree in ${trashed} back: ${messageOf(error)}`)
    }
  }
}

/** guard を通って GRACE_MS たった捨て場を消す。1 つでも消せなければ、残りを消してから reject する。 */
export async function sweepTrashedWorktrees(trash: string) {
  const cutoff = Date.now() - GRACE_MS
  const failures: string[] = []
  for (const trashed of entriesOf(trash)) {
    try {
      if (existsSync(markOf(trashed)) || statSync(trashed).mtimeMs > cutoff) continue
      await removeTree(trashed)
    } catch (error) {
      failures.push(messageOf(error))
    }
  }
  if (failures.length > 0) {
    throw new Error(`could not delete the trashed worktrees: ${failures.join('; ')}`)
  }
}

function entriesOf(trash: string): string[] {
  if (!existsSync(trash)) return []
  return readdirSync(trash)
    .map((name) => join(trash, name))
    .toSorted()
}

// 同期の削除は数万の unlink の間 Backend の event loop を止めるので、子 process に任せる。
async function removeTree(path: string) {
  const rm = Bun.spawn(['rm', '-rf', path], {
    env: process.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const [stderr, code] = await Promise.all([new Response(rm.stderr).text(), rm.exited])
  if (code !== 0) {
    throw new Error(stderr.trim().split('\n').at(-1) || `rm -rf ${path}: exit ${code}`)
  }
}
