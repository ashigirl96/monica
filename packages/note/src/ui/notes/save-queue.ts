import { ORPCError } from '@orpc/client'

import type { Doc } from '../../contract.ts'
import {
  type NoteConflict,
  nextSaveErrors,
  removeConflict,
  removeSaveError,
  shouldAdvanceBase,
  upsertConflict,
} from './save-state.ts'

const DEBOUNCE_MS = 1000
const RETRY_MS = 5000

/** schedule に渡す payload。基準版は台帳が持つのでここには載らない。title を持たない
 * kind（daily）は title を省く。 */
export type NoteDraft = { content: { toJSON: () => Doc }; title?: string }

export type SaveInput = { id: string; content: Doc; title?: string; expectedUpdatedAt: Date }

export type SaveNote = (input: SaveInput, keepalive: boolean) => Promise<{ updatedAt: Date }>

/**
 * ノート id ごとに最新 payload を保持し、1 秒 debounce で保存する。flush はノート切替・
 * pagehide（keepalive の保存）から呼ばれる。失敗した payload は同 id のより新しい pending や
 * 削除済み id がない限り復元し、RETRY_MS 後に自動再試行する。
 *
 * 併せて id ごとの基準版（最後に読んだ / 書いた updatedAt）を台帳に持ち、保存に
 * expectedUpdatedAt として添える。サーバが CONFLICT を返したら他クライアントに先を越された
 * ということなので、再試行せず競合台帳に積んで呼び手に委ねる（同じ stale な基準版で
 * 再試行しても永久に CONFLICT になるため）。
 */
export class SaveQueue {
  #save: SaveNote
  #pending = new Map<string, NoteDraft>()
  #discarded = new Set<string>()
  // id ごとの基準版。保存が返す updatedAt で前進させる
  #versions = new Map<string, Date>()
  // 送信中の id。差し替え判定が in-flight な書き込みを見落とさないために要る
  #inflight = new Set<string>()
  // CONFLICT で行き場を失った draft。再送しても永久に CONFLICT なので pending には戻さないが、
  // 「未保存」ではあるので削除や content 採用の前で止められるよう別に持つ
  #conflicted = new Map<string, NoteDraft>()
  // 競合通知に出す見出し。kind ごとの決め方はページの知識なので schedule で受け取る
  #labels = new Map<string, string>()
  #timer: ReturnType<typeof setTimeout> | null = null
  // flush を直列化し、古い payload の保存が新しい保存を追い越して上書きするのを防ぐ
  #chain: Promise<void> = Promise.resolve()
  // 保存エラーも id ごとに持つ。全体で 1 値にすると、note A の失敗が note B のヘッダに
  // 出て「B の保存が落ちた」と嘘をつく（autosave がアプリ全体で 1 つになったため）
  #errors: Record<string, string> = {}
  // 競合の一覧。開いている note に依らず保持するので、離脱後に返った CONFLICT も surface できる
  #conflicts: NoteConflict[] = []
  #listeners = new Set<() => void>()

  constructor(save: SaveNote) {
    this.#save = save
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  errors = (): Readonly<Record<string, string>> => this.#errors

  conflicts = (): NoteConflict[] => this.#conflicts

  baseVersion = (id: string): Date | null => this.#versions.get(id) ?? null

  /** 前進の可否は shouldAdvanceBase が持つ（単調性 + 競合中のピン留め）。 */
  setBase = (id: string, updatedAt: Date): void => {
    const current = this.#versions.get(id) ?? null
    if (!shouldAdvanceBase(current, updatedAt, this.#conflicted.has(id))) return
    this.#versions.set(id, updatedAt)
  }

  /** 未保存（pending・送信中・競合で滞留）の編集を抱えているか。 */
  hasUnsaved = (id: string): boolean =>
    this.#pending.has(id) || this.#inflight.has(id) || this.#conflicted.has(id)

  /** 閉じると失われる編集があるか。届く Backend への未保存は pagehide の flush が送るので数えない。 */
  wouldLoseOnLeave = (unreachable: boolean): boolean => {
    if (this.#conflicted.size > 0) return true
    // pagehide の flush は送信中の保存の後ろに並ぶので、その保存が返る前にページごと消える。
    if (this.#pending.size > 0 && this.#inflight.size > 0) return true
    const unsent = [...this.#pending.keys(), ...this.#inflight]
    return unsent.length > 0 && (unreachable || unsent.some((id) => id in this.#errors))
  }

  /** pending を出し切る。成否は id ごとに `hasUnsaved(id)` で見る — 呼び手が気にするのは
   * 常に自分が触っている note の 1 件で、無関係な note の失敗で操作を止める理由はない。 */
  flush = (keepalive = false): Promise<void> => {
    const settled = this.#chain.then(() => this.#run(keepalive))
    this.#chain = settled
    return settled
  }

  schedule = (id: string, draft: NoteDraft, label: string): void => {
    this.#pending.set(id, draft)
    this.#labels.set(id, label)
    this.#clearTimer()
    this.#timer = setTimeout(() => void this.flush(), DEBOUNCE_MS)
  }

  /** ノート削除時、その id 宛の pending と in-flight 失敗時の復元を無効化する */
  discard = (id: string): void => {
    this.#discarded.add(id)
    this.#pending.delete(id)
    this.#conflicted.delete(id)
    this.#labels.delete(id)
    this.#setConflicts(removeConflict(this.#conflicts, id))
    this.#setErrors(removeSaveError(this.#errors, id))
    if (this.#pending.size === 0) this.#clearTimer()
  }

  /** undo で復活した note の再試行を戻す。同じページに留まったまま復活すると
   * discard の印が残り続け、以降その id の保存失敗が再試行されなくなるため。 */
  resume = (id: string): void => {
    this.#discarded.delete(id)
  }

  /** 競合解決で「サーバの最新を読む」を選んだときに、捨てる編集を落とす。
   * discard と違い削除済みの印は残さない（そのまま編集を続けられる）。
   * 基準版のピン（shouldAdvanceBase）が解けるのはこの経路だけ。 */
  dropPending = (id: string): void => {
    this.#pending.delete(id)
    this.#conflicted.delete(id)
    this.#versions.delete(id)
    this.#setConflicts(removeConflict(this.#conflicts, id))
    this.#setErrors(removeSaveError(this.#errors, id))
    if (this.#pending.size === 0) this.#clearTimer()
  }

  async #run(keepalive: boolean): Promise<void> {
    this.#clearTimer()
    if (this.#pending.size === 0) return
    const batch = this.#pending
    this.#pending = new Map()
    const attempted = [...batch.keys()]
    const failures: Record<string, string> = {}
    await Promise.all(
      [...batch].map(([id, draft]) => {
        this.#inflight.add(id)
        return this.#send(id, draft, keepalive)
          .then((version) => this.setBase(id, version.updatedAt))
          .catch((e: unknown) => {
            if (e instanceof ORPCError && e.code === 'CONFLICT') {
              // 基準版が古いので同じ payload を投げ直しても永久に CONFLICT。pending へ戻して
              // リトライさせず、競合として保持したうえで通知とバナーに渡す。
              // failure にはしない（自動リトライを誘発し、競合表示とも二重になる）。
              this.#conflicted.set(id, draft)
              const label = this.#labels.get(id) ?? 'Untitled'
              this.#setConflicts(upsertConflict(this.#conflicts, { id, label }))
              return
            }
            if (!this.#discarded.has(id) && !this.#pending.has(id)) {
              this.#pending.set(id, draft)
            }
            failures[id] = e instanceof Error ? e.message : 'Failed to save'
          })
          .finally(() => this.#inflight.delete(id))
      }),
    )
    this.#setErrors(nextSaveErrors(this.#errors, attempted, failures))
    if (Object.keys(failures).length > 0 && this.#pending.size > 0 && this.#timer === null) {
      this.#timer = setTimeout(() => void this.flush(), RETRY_MS)
    }
  }

  async #send(id: string, draft: NoteDraft, keepalive: boolean): Promise<{ updatedAt: Date }> {
    const expectedUpdatedAt = this.#versions.get(id)
    if (expectedUpdatedAt === undefined) throw new Error(`no version of ${id} to save on`)
    const { content, ...rest } = draft
    return this.#save({ id, ...rest, content: content.toJSON(), expectedUpdatedAt }, keepalive)
  }

  #clearTimer(): void {
    if (this.#timer === null) return
    clearTimeout(this.#timer)
    this.#timer = null
  }

  // useSyncExternalStore は参照で変化を見るので、変えるときは新しい値に差し替える。
  #setErrors(next: Record<string, string>): void {
    this.#errors = next
    this.#notify()
  }

  #setConflicts(next: NoteConflict[]): void {
    this.#conflicts = next
    this.#notify()
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }
}
