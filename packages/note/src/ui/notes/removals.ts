import { ORPCError } from '@orpc/client'

import type { Note } from '../../contract.ts'
import type { RemovalScreen } from '../routes.ts'

export type RemovableKind = NonNullable<RemovalScreen>['kind']

type RemovalDeps = {
  flush: () => Promise<void>
  hasUnsaved: (id: string) => boolean
  remove: (id: string) => Promise<void>
  restore: (id: string) => Promise<Note>
  discard: (id: string) => void
  forgetBody: (id: string) => void
  /** URL が開いている Note の id。待つ間に移ることがあるので、待った後に読む。 */
  openId: () => string | null
}

type Screen = {
  /** 消した Note を開いていたときの移り先へ移る。 */
  leave: () => void
}

/**
 * Note の削除と取り消し。削除した Note を取り消せるのは削除した画面にいる間だけなので、
 * 別の画面に着いたら作り直して stack を捨てる。
 */
export class Removals {
  #kind: RemovableKind
  #deps: RemovalDeps
  #removed: string[] = []

  constructor(kind: RemovableKind, deps: RemovalDeps) {
    this.#kind = kind
    this.#deps = deps
  }

  get kind(): RemovableKind {
    return this.#kind
  }

  /** 消せたら true。未保存の編集が残る間は消さない（⌥Z で戻せるのが server に届いた本文までになる）。 */
  async remove(id: string, { leave }: Screen): Promise<boolean> {
    const removed = await this.#remove(id)
    if (removed && this.#deps.openId() === id) leave()
    return removed
  }

  /** 外で消された Note の後始末。この画面で消したのではないので、取り消しの stack には積まない。 */
  removedElsewhere(id: string, { leave }: Screen): void {
    this.#forget(id)
    if (this.#deps.openId() === id) leave()
  }

  /** 最後に消した Note を戻す。失敗したら stack に戻し、次の ⌥Z で試し直せるようにする。 */
  async undo(): Promise<Note | null> {
    const id = this.#removed.pop()
    if (id === undefined) return null
    const index = this.#removed.length
    let restored: Note
    try {
      restored = await this.#deps.restore(id)
    } catch {
      // 待つ間に積まれた削除より前に戻し、削除の順を崩さない。
      this.#removed.splice(index, 0, id)
      return null
    }
    return restored
  }

  async #remove(id: string): Promise<boolean> {
    await this.#deps.flush()
    if (this.#deps.hasUnsaved(id)) return false
    try {
      await this.#deps.remove(id)
    } catch {
      return false
    }
    // 往復の間にその Note を開いて打った分は、捨てずに戻した Note へ保存させる。
    if (this.#deps.hasUnsaved(id) && (await this.#putBack(id))) return false
    this.#forget(id)
    this.#removed.push(id)
    return true
  }

  #forget(id: string) {
    // 予約が残ると保存が NOT_FOUND で再試行を繰り返し、本文の cache が残ると履歴で戻ったときに消した Note を開く。
    this.#deps.discard(id)
    this.#deps.forgetBody(id)
  }

  async #putBack(id: string): Promise<boolean> {
    try {
      await this.#deps.restore(id)
      return true
    } catch {
      return false
    }
  }
}

/** 消されたとみなすのは Backend の答えだけ。ほかの失敗は届かなかっただけかもしれない。 */
export function isNotFound(error: Error | null): boolean {
  return error instanceof ORPCError && error.code === 'NOT_FOUND'
}
