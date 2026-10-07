export type BlockTarget = { noteId: string; blockId: string }

// 別の Note へ移ると、移った先でエディタが作り直されるまで飛び先を持つ場所が無い。
let pending: BlockTarget | null = null

export function jumpToBlock(
  target: BlockTarget,
  openNoteId: string,
  {
    scrollToBlock,
    openNote,
  }: { scrollToBlock: (blockId: string) => void; openNote: (noteId: string) => void },
): void {
  if (target.noteId === openNoteId) {
    scrollToBlock(target.blockId)
    return
  }
  pending = target
  openNote(target.noteId)
}

/** 開いた Note に置かれた飛び先。StrictMode が effect を 2 度走らせても、2 度とも同じ飛び先を返す。 */
export function arrivalAt(noteId: string): () => string | null {
  let taken: string | null | undefined
  return () => {
    if (taken !== undefined) return taken
    taken = pending?.noteId === noteId ? pending.blockId : null
    if (taken !== null) pending = null
    return taken
  }
}
