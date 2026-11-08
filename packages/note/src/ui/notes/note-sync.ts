import type { Note } from '../../contract.ts'
import type { UnsavedDraft } from './save-queue.ts'

/**
 * サーバから届いた note を「編集中の doc と差し替えるべきか」。
 *
 * `!==` ではなく `>` で比べるのが要点。保存の in-flight 中に走った再フェッチが掴んだ
 * 「書き込み前の doc」を外部更新と誤認して差し戻す事故を弾ける。
 */
export function shouldAdoptServerDoc(args: {
  fetchedUpdatedAt: Date
  baseUpdatedAt: Date | null
  hasUnsaved: boolean
}): boolean {
  // 未保存があるうちは差し替えない（ローカル編集が消える）。Note Conflict は保存の CONFLICT が拾う。
  if (args.hasUnsaved) return false
  // 初回ロードは mount がそのまま反映するので世代を進める必要がない。
  if (args.baseUpdatedAt === null) return false
  return args.fetchedUpdatedAt.getTime() > args.baseUpdatedAt.getTime()
}

/**
 * 採用してよいサーバ doc かどうか。autosave の保存は doc を返さないので、保存直後の
 * query cache は 1 世代古い。そこから editor を mount すると自分の保存済み編集を巻き戻し、
 * 次の打鍵でそのまま上書き保存してしまう。fresh が届くまで採用しない。
 */
export function usableServerDoc(note: Note | undefined, baseUpdatedAt: Date | null): Note | null {
  if (note === undefined) return null
  if (baseUpdatedAt !== null && note.updatedAt.getTime() < baseUpdatedAt.getTime()) return null
  return note
}

/**
 * 開いた画面に出す note。未保存の本文と title は autosave にしか無いので、cache のものより優先する。
 * cache の title で開くと、次の打鍵の draft が未保存の title を古い title で置き換える。
 * その編集は Base Version に積んだものなので版も Base Version のままにし、cache に外の新しい版が入っていても
 * Base Version を進めない（進めると、保存が外の変更を Note Conflict にならずに上書きする）。
 */
export function noteToOpen(
  data: Note,
  baseUpdatedAt: Date | null,
  unsaved: UnsavedDraft | null,
): Note | null {
  if (unsaved !== null && baseUpdatedAt !== null) {
    const opened = { ...data, content: unsaved.content, updatedAt: baseUpdatedAt }
    if (unsaved.title !== undefined && 'title' in opened) return { ...opened, title: unsaved.title }
    return opened
  }
  return usableServerDoc(data, baseUpdatedAt)
}
