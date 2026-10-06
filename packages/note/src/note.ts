import { join } from 'node:path'

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import { cleanImages, type ImageDeps, serveImage } from './image.ts'

export type Db = BunSQLiteDatabase

export type NoteLedger = {
  start(): void
  stop(): void
  /** 消せなかった画像があれば、残りを消してから reject する。 */
  cleanImages(): Promise<void>
  /** oRPC の RPCHandler は File を multipart に包むので、`<img src>` が読む生のバイト列はここから返す。 */
  serveImage(name: string): Promise<Response>
}

// note は job を import しないので、createJobLedger の systemJobs と同じ構造の素のオブジェクトで返す。
export function systemJobs(noteLedger: NoteLedger) {
  return [
    {
      name: 'note.image-cleanup',
      every: 24 * 60 * 60_000,
      run: () => noteLedger.cleanImages(),
    },
  ]
}

// NoteLedger の型は Backend の組み立てが呼ぶものだけに保ち、procedure が使う中身は NoteLedger を key にここへ置く。
const internalsOf = new WeakMap<NoteLedger, ImageDeps>()

export function internals(noteLedger: NoteLedger): ImageDeps {
  const found = internalsOf.get(noteLedger)
  if (!found) throw new Error('this NoteLedger was not made by createNoteLedger')
  return found
}

export function createNoteLedger(deps: { db: Db; home: string }): NoteLedger {
  const dir = join(deps.home, 'note-images')
  const stopped = new AbortController()
  const noteLedger: NoteLedger = {
    start() {},
    stop() {
      stopped.abort()
    },
    cleanImages: () => cleanImages(deps.db, dir),
    serveImage: (name) => serveImage(dir, name),
  }
  internalsOf.set(noteLedger, { dir, stopped: stopped.signal })
  return noteLedger
}
