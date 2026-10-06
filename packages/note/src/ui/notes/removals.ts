import type { Note } from '../../contract.ts'

type RemovalDeps = {
  flush: () => Promise<void>
  hasUnsaved: (id: string) => boolean
  remove: (id: string) => Promise<void>
  restore: (id: string) => Promise<Note>
  discard: (id: string) => void
  resume: (id: string) => void
}

/** 画面のエディタ。保存の経路は `noteRef` の note へ予約するので、外せば予約が止まる。 */
type Editor = {
  noteRef: { current: Note | null }
  reschedule: (note: Note) => void
}

/**
 * Note の削除と取り消し。削除した Note を取り消せるのは削除した画面にいる間だけなので、
 * stack は画面が持ち、画面と一緒に捨てる。
 */
export class Removals {
  #deps: RemovalDeps
  #removed: string[] = []

  constructor(deps: RemovalDeps) {
    this.#deps = deps
  }

  /** 消せたら true。未保存の編集が残る間は消さない（⌥Z で戻せるのが server に届いた本文までになる）。 */
  async remove(id: string, editor: Editor): Promise<boolean> {
    const open = editor.noteRef.current?.id === id ? editor.noteRef.current : null
    if (open !== null) editor.noteRef.current = null
    const removed = await this.#remove(id)
    // 待つ間に別の note を開いていたら、その note の打鍵が消せなかった note へ保存されないよう、開き直さない。
    if (!removed && open !== null && editor.noteRef.current === null) {
      editor.noteRef.current = open
      // 締めている間に打った分はエディタが持っているので、保存し直す。
      editor.reschedule(open)
    }
    return removed
  }

  /** 最後に消した Note を戻す。失敗したら stack に戻し、次の ⌥Z で試し直せるようにする。 */
  async undo(): Promise<Note | null> {
    const id = this.#removed.pop()
    if (id === undefined) return null
    let restored: Note
    try {
      restored = await this.#deps.restore(id)
    } catch {
      this.#removed.push(id)
      return null
    }
    this.#deps.resume(id)
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
    // 消した Note への保存の再試行が NOT_FOUND を叩き続けないよう、予約を捨てる。
    this.#deps.discard(id)
    this.#removed.push(id)
    return true
  }
}
