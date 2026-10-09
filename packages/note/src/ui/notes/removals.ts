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

/** 画面のエディタ。保存の経路は `noteRef` の Note へ予約するので、外せば予約が止まる。 */
type Editor = {
  noteRef: { current: Note | null }
  reschedule: (note: Note) => void
}

type Screen = {
  editor?: Editor
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
  async remove(id: string, { editor, leave }: Screen): Promise<boolean> {
    const open = editor?.noteRef.current?.id === id ? editor.noteRef.current : null
    // 種類ごとの route は別の種類の id でも開くので、ここで見ないと別の画面の Note を消してしまう。
    if (open !== null && open.kind !== this.#kind) return false
    const removed =
      open === null || editor === undefined
        ? await this.#remove(id)
        : await this.#removeOpen(open, editor)
    if (removed && this.#deps.openId() === id) leave()
    return removed
  }

  /** 外で消された Note の後始末。この画面で消したのではないので、取り消しの stack には積まない。 */
  removedElsewhere(
    id: string,
    { editor, leave }: Pick<Screen, 'leave'> & { editor: Pick<Editor, 'noteRef'> },
  ): void {
    if (editor.noteRef.current?.id === id) editor.noteRef.current = null
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

  async #removeOpen(open: Note, editor: Editor): Promise<boolean> {
    // 待つ間の打鍵を予約すると flush の成否に入らず、消した後の保存が NOT_FOUND を繰り返す。
    editor.noteRef.current = null
    if (await this.#remove(open.id)) return true
    // 移った先の打鍵を消せなかった Note へ保存しないよう、待つ間に別の Note へ移っていたら開き直さない（`noteRef` は描画まで空のままなので URL でも見る）。
    if (editor.noteRef.current === null && this.#deps.openId() === open.id) {
      editor.noteRef.current = open
      // 締めている間に打った分はエディタが持っているので、保存し直す。
      editor.reschedule(open)
    }
    return false
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
