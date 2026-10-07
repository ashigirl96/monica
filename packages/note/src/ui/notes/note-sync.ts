import { type RefObject, useCallback, useEffect, useState } from 'react'

import type { Doc, Note } from '../../contract.ts'
import type { Autosave } from './use-autosave.ts'

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
  // 未保存があるうちは差し替えない（ローカル編集が消える）。競合は保存の CONFLICT が拾う。
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
 * 開いた画面に出す note。未保存の編集は autosave にしか無いので、cache の本文より優先する。
 * その本文は基準版に積んだものなので版も基準版のままにし、cache に外の新しい版が入っていても
 * 基準版を進めない（進めると、保存が外の変更を競合なしで上書きする）。
 */
export function noteToOpen(
  data: Note,
  baseUpdatedAt: Date | null,
  unsaved: Doc | null,
): Note | null {
  if (unsaved !== null && baseUpdatedAt !== null) {
    return { ...data, content: unsaved, updatedAt: baseUpdatedAt }
  }
  return usableServerDoc(data, baseUpdatedAt)
}

/** useQuery の refetch のうち、この hook が使う部分だけの形。 */
type RefetchNote = () => Promise<{ data?: Note; isError: boolean }>

/**
 * 「最新を読み込む」の実体。取り直しが失敗しても TanStack Query は古い cache を data に
 * 残して返すので、成功を確かめてから未送信の編集を捨て、取り直した doc を採用する。
 * 取り直しの間に書いた編集は捨てずに、競合のまま残す。画面は取り直しの間も別の note へ
 * 移れるので、返った時にその note がまだ開いていなければ採用しない。
 */
export async function reloadLatest({
  id,
  refetch,
  dropPending,
  adopt,
  editMark,
  isOpen,
}: {
  id: string | undefined
  refetch: RefetchNote
  dropPending: (id: string) => void
  adopt: (next: Note) => void
  editMark: (id: string) => number
  isOpen: () => boolean
}): Promise<void> {
  const mark = id === undefined ? null : editMark(id)
  const fresh = await refetch()
  if (fresh.isError || fresh.data === undefined || !isOpen()) return
  if (id !== undefined && editMark(id) !== mark) return
  // 基準版ごと落とすので、取り直した doc は無条件に採用できる
  if (id !== undefined) dropPending(id)
  adopt(fresh.data)
}

/**
 * query の結果を editor に載せる doc へ変換する。一度採用した doc は latch して保持し、
 * docKey が変わる・外部更新を採用する・reload する、のいずれかまで手放さない。
 *
 * latch が要るのは、`usableServerDoc` を毎レンダーの素通しフィルタにすると編集フローが
 * 壊れるため（保存直後は常に cache < base なので、title 入力の再レンダーでエディタが消える）。
 *
 * `docKey` は「今どの doc を見ているか」の識別子。Daily は date（note id はフェッチするまで
 * 分からない）。
 */
export function useServerDoc({
  docKey,
  data,
  autosave,
  contentRef,
  noteRef,
  refetch,
}: {
  docKey: string
  data: Note | undefined
  autosave: Autosave
  contentRef: RefObject<unknown>
  /** 保存経路（onDocChange / 削除 / status トグル）が closure を跨いで読む最新 note。
   * 削除は `noteRef.current = null` で予約を締めるので、同期は adopt と patchNote に閉じる
   * （毎レンダーの effect で書き戻すと、締めている間の再レンダーでゲートが開いてしまう）。 */
  noteRef: RefObject<Note | null>
  refetch: RefetchNote
}) {
  const [note, setNote] = useState<Note | null>(null)
  // 再マウントの世代。自分の保存では進まないので打鍵中にカーソルと undo が飛ばない
  const [generation, setGeneration] = useState(0)
  const [lastKey, setLastKey] = useState(docKey)
  const { baseVersion, setBase, hasUnsaved, dropPending, setOpenNote, unsavedContent, editMark } =
    autosave

  if (lastKey !== docKey) {
    // doc が変わったら latch を破棄する。派生値でマスクするだけだと、採用が終わる前に
    // 元の doc へ戻ったとき前の snapshot がそのまま再露出してガードを素通りする。
    setLastKey(docKey)
    setNote(null)
    // oxlint-disable-next-line react/refs -- noteRef は latch の写しなので、latch と同じ所で手放し、latch が空なのに古い note へ保存を予約できる間を作らない。
    noteRef.current = null
  }
  const current = lastKey === docKey ? note : null

  const adopt = useCallback(
    (next: Note, bumpGeneration: boolean) => {
      contentRef.current = next.content
      noteRef.current = next
      setBase(next.id, next.updatedAt)
      setNote(next)
      if (bumpGeneration) setGeneration((g) => g + 1)
    },
    [contentRef, noteRef, setBase],
  )

  useEffect(() => {
    if (data === undefined) return
    // 基準版は届いた note の id で引く。latch を捨てた直後（往復で戻ってきた直後）でも
    // 台帳は生きているので、1 世代古い cache をここで確実に弾ける。
    const base = baseVersion(data.id)
    if (current === null) {
      const opened = noteToOpen(data, base, unsavedContent(data.id))
      // oxlint-disable-next-line react/set-state-in-effect -- 採用は render の外の autosave の基準版も進めるので、render ではなく effect で行う。
      if (opened !== null) adopt(opened, false)
      return
    }
    const usable = usableServerDoc(data, base)
    if (usable === null) return
    const adoptable = shouldAdoptServerDoc({
      fetchedUpdatedAt: usable.updatedAt,
      baseUpdatedAt: base,
      hasUnsaved: hasUnsaved(usable.id),
    })
    if (adoptable) adopt(usable, true)
  }, [data, current, adopt, baseVersion, hasUnsaved, unsavedContent])

  const openId = current?.id ?? null
  useEffect(() => {
    // 開いている note を autosave へ知らせる。グローバルな競合通知は、ヘッダのバナーが
    // 担当している note の行を出さないためにこれを見る。
    setOpenNote(openId)
    return () => setOpenNote(null)
  }, [openId, setOpenNote])

  /** latch の note だけを差し替える。title の編集のように、サーバから届いた本文を伴わない
   * 更新に使うので、基準版も世代も進めない。 */
  const patchNote = useCallback(
    (next: Note) => {
      noteRef.current = next
      setNote(next)
    },
    [noteRef],
  )

  const reload = useCallback(() => {
    const id = current?.id
    return reloadLatest({
      id,
      refetch,
      dropPending,
      adopt: (next) => adopt(next, true),
      editMark,
      isOpen: () => noteRef.current?.id === id,
    })
  }, [current, dropPending, refetch, adopt, editMark, noteRef])

  return { note: current, generation, reload, adopt, patchNote }
}
