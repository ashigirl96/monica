import { type QueryClient, QueryObserver, type QueryObserverResult } from '@tanstack/react-query'

import { displayName, type Note } from '../../contract.ts'
import type { NoteClient } from '../client.ts'
import { queryKeys } from '../query.ts'
import { dayLabelWithYear } from './dates.ts'
import { persistableContent } from './editor-support.ts'
import { nextEssayStatus } from './essay-status.ts'
import { readBody } from './note-body.tsx'
import { noteToOpen, shouldAdoptServerDoc, usableServerDoc } from './note-sync.ts'
import type { NoteQueryOptions } from './queries.ts'
import { isNotFound, type Removals } from './removals.ts'
import type { SaveQueue } from './save-queue.ts'

type Saves = Pick<
  SaveQueue,
  | 'schedule'
  | 'flush'
  | 'setBase'
  | 'baseVersion'
  | 'hasUnsaved'
  | 'unsavedDraft'
  | 'editMark'
  | 'dropPending'
>

type OpenNoteDeps = {
  queryClient: QueryClient
  saves: Saves
  client: { essay: Pick<NoteClient['essay'], 'setStatus'> }
  /** 画面に出ている Note を autosave に知らせる。Note Conflict の通知はその Note の行を出さない。 */
  showOpen: (id: string | null) => void
  /** URL が開いている Note の id。navigate は URL をその場で書き換えるが、描画は後になる。 */
  openId: () => string | null
}

export type OpenNoteView = {
  key: string | null
  /** 画面に出す Note。採用した版を latch して、key が替わるか新しい版を採るまで手放さない。 */
  note: Note | null
  /** editor を作り直す世代。自分の保存では進まないので、打鍵中にカーソルと undo が飛ばない。 */
  generation: number
  data: Note | undefined
  error: Error | null
  /** 外で消された、画面に出ている Note の id。 */
  gone: string | null
}

function hasTitle(note: Note): note is Extract<Note, { title: string }> {
  return note.kind === 'essay' || note.kind === 'repo_note'
}

export function emptyView(key: string | null, generation: number): OpenNoteView {
  return { key, note: null, generation, data: undefined, error: null, gone: null }
}

function labelOf(note: Note): string {
  return note.kind === 'daily' ? dayLabelWithYear(note.date) : displayName(note)
}

/**
 * Open Note の編集。保存を予約する経路はすべて `#editing` の Note へ予約するので、
 * それを null にすれば予約が止まる（削除の間と、外で消された後）。画面に出す Note とは別に持つ。
 */
export class OpenNote {
  #deps: OpenNoteDeps
  #observer: QueryObserver<Note, Error, Note, Note> | null = null
  #unsubscribe: (() => void) | null = null
  #attached = false
  #accepts: (note: Note) => boolean = () => true
  #editing: Note | null = null
  #content: unknown = null
  #view: OpenNoteView = emptyView(null, 0)
  #told: string | null = null
  #listeners = new Set<() => void>()
  // 連打した 2 回が同じ status を読んで 1 回に潰れないよう、切り替えを直列にする
  #statusChain: Promise<unknown> = Promise.resolve()

  constructor(deps: OpenNoteDeps) {
    this.#deps = deps
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  view = (): OpenNoteView => this.#view

  /** 保存の予約先。null の間は書いても保存しない。 */
  get editing(): Note | null {
    return this.#editing
  }

  attach = (): (() => void) => {
    this.#attached = true
    this.#subscribeObserver()
    this.#tell()
    return () => {
      this.#attached = false
      this.#unsubscribe?.()
      this.#unsubscribe = null
      this.#told = null
      this.#deps.showOpen(null)
    }
  }

  /** `key` の Note を開く。key が替わったら latch と予約先を捨てる。`accepts` が断る Note は採らない。 */
  open(key: string, options: NoteQueryOptions, accepts: (note: Note) => boolean = () => true) {
    this.#accepts = accepts
    if (key === this.#view.key) return
    this.#editing = null
    this.#view = emptyView(key, this.#view.generation)
    if (this.#observer === null) {
      this.#observer = new QueryObserver(this.#deps.queryClient, options)
      this.#subscribeObserver()
    } else {
      this.#observer.setOptions(options)
    }
    this.#take(this.#observer.getCurrentResult())
    this.#publish()
  }

  changeBody = (doc: unknown): void => {
    this.#content = doc
    if (this.#editing !== null) this.#schedule(this.#editing)
  }

  changeTitle = (title: string): Note | null => {
    const current = this.#editing
    if (current === null || !hasTitle(current)) return null
    const next = { ...current, title }
    this.#patch(next)
    this.#schedule(next)
    return next
  }

  /**
   * 最新の読み込み。取り直しが失敗しても TanStack Query は古い cache を data に残して返すので、
   * 成功を確かめてから未送信の編集を捨てる。取り直しの間に書いた編集は捨てずに Note Conflict のまま残す。
   */
  reload = async (): Promise<void> => {
    const observer = this.#observer
    const id = this.#editing?.id
    if (observer === null || id === undefined) return
    const mark = this.#deps.saves.editMark(id)
    const fresh = await observer.refetch()
    if (fresh.isError || fresh.data === undefined || this.#editing?.id !== id) return
    if (this.#deps.saves.editMark(id) !== mark) return
    // Base Version ごと落とすので、取り直した doc は無条件に採用できる
    this.#deps.saves.dropPending(id)
    this.#adopt(fresh.data, true)
  }

  toggleStatus = (): Promise<Note | null> => {
    const targetId = this.#editing?.id
    if (targetId === undefined) return Promise.resolve(null)
    const run = this.#statusChain.then(() => this.#setStatus(targetId))
    this.#statusChain = run.catch(() => {})
    return run
  }

  /**
   * Note を消す。Open Note なら、待つ間の打鍵を予約しないよう予約先を外し、
   * 消せなかったら開き直して、外している間に打った分を保存し直す。
   */
  async remove(id: string, removals: Removals, leave: () => void): Promise<boolean> {
    const open = this.#editing?.id === id ? this.#editing : null
    if (open === null) return removals.remove(id, { leave })
    // 種類ごとの route は別の種類の id でも開くので、ここで見ないと別の画面の Note を消してしまう。
    if (open.kind !== removals.kind) return false
    // 待つ間の打鍵を予約すると flush の成否に入らず、消した後の保存が NOT_FOUND を繰り返す。
    this.#editing = null
    const removed = await removals.remove(id, { leave })
    // 移った先の打鍵を消せなかった Note へ保存しないよう、待つ間に別の Note へ移っていたら開き直さない（予約先は描画まで空のままなので URL でも見る）。
    if (!removed && this.#editing === null && this.#deps.openId() === id) {
      this.#editing = open
      this.#schedule(open)
    }
    return removed
  }

  async #setStatus(targetId: string): Promise<Note | null> {
    const { saves, client, queryClient } = this.#deps
    const current = this.#editing
    if (current === null || current.id !== targetId || current.kind !== 'essay') return null
    await saves.flush()
    // 進めた版を Base Version にすると、Note Conflict で残った古い本文が次の保存で外の変更を上書きする。
    if (saves.hasUnsaved(current.id)) return null
    // 未保存が無いので、画面の title と本文は Backend の版と同じはず。
    const shown = this.#editing?.kind === 'essay' ? this.#editing : current
    const shownDoc = JSON.stringify(persistableContent(this.#content).toJSON())
    const status = nextEssayStatus(current.status)
    const updated = await client.essay.setStatus({ id: current.id, status })
    if (updated.kind !== 'essay') return null
    // 外で書き換わった版を Base Version にすると、画面の古い本文が次の保存でその変更を Note Conflict にならずに上書きする。
    const statusOnly = updated.title === shown.title && JSON.stringify(updated.content) === shownDoc
    if (statusOnly) saves.setBase(updated.id, updated.updatedAt)
    const open = this.#editing
    if (open?.id !== updated.id) return updated
    // 往復の間に打った本文は返った本文より新しい。
    if (saves.hasUnsaved(updated.id)) {
      if (open.kind === 'essay') this.#patch({ ...open, status: updated.status })
    } else {
      // 先に cache へ置くと、observer が Base Version の進む前に受けて、もう一度採用する。
      this.#adopt(updated, !statusOnly)
      queryClient.setQueryData(queryKeys.note(updated.id), updated)
    }
    return updated
  }

  #schedule(target: Note): void {
    if (!readBody(target.content).ok) return
    const content = persistableContent(this.#content ?? target.content)
    // Scratch・Daily・Pad の保存に title を付けると、server は本文ごと断る。
    const draft = hasTitle(target) ? { content, title: target.title } : { content }
    this.#deps.saves.schedule(target.id, draft, labelOf(target))
  }

  #subscribeObserver(): void {
    const observer = this.#observer
    if (!this.#attached || observer === null || this.#unsubscribe !== null) return
    this.#unsubscribe = observer.subscribe((result) => {
      this.#take(result)
      this.#publish()
    })
    this.#take(observer.getCurrentResult())
    this.#publish()
  }

  #take({ data, error }: QueryObserverResult<Note>): void {
    const shown = this.#view.note
    let gone = this.#view.gone
    // 開いた本文を出し続けると、書いた分の保存が NOT_FOUND で再試行され続ける。
    if (gone === null && shown !== null && isNotFound(error)) {
      this.#editing = null
      gone = shown.id
    }
    this.#view = { ...this.#view, data, error, gone }
    if (data === undefined || gone !== null || !this.#accepts(data)) return
    const { saves } = this.#deps
    // Base Version は届いた note の id で引く。latch を捨てた直後（往復で戻ってきた直後）でも
    // 台帳は生きているので、1 世代古い cache をここで確実に弾ける。
    const base = saves.baseVersion(data.id)
    if (shown === null) {
      const opened = noteToOpen(data, base, saves.unsavedDraft(data.id))
      if (opened !== null) this.#adopt(opened, false)
      return
    }
    const usable = usableServerDoc(data, base)
    if (usable === null) return
    const adoptable = shouldAdoptServerDoc({
      fetchedUpdatedAt: usable.updatedAt,
      baseUpdatedAt: base,
      hasUnsaved: saves.hasUnsaved(usable.id),
    })
    if (adoptable) this.#adopt(usable, true)
  }

  #adopt(next: Note, remount: boolean): void {
    this.#content = next.content
    this.#editing = next
    this.#deps.saves.setBase(next.id, next.updatedAt)
    const generation = this.#view.generation + (remount ? 1 : 0)
    this.#view = { ...this.#view, note: next, generation }
    this.#publish()
  }

  /** title の編集のように、サーバから届いた本文を伴わない更新。Base Version も世代も進めない。 */
  #patch(next: Note): void {
    this.#editing = next
    this.#view = { ...this.#view, note: next }
    this.#publish()
  }

  #publish(): void {
    this.#tell()
    for (const listener of this.#listeners) listener()
  }

  #tell(): void {
    const id = this.#view.note?.id ?? null
    if (!this.#attached || id === this.#told) return
    this.#told = id
    this.#deps.showOpen(id)
  }
}
