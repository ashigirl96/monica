// 別ノートの synced block へジャンプする際、navigate → ページ/エディタの再マウントを
// 跨いで対象 block を運ぶ one-shot の受け渡し。NotesPage 内の遷移も /daily からの
// cross-note ジャンプも同じ経路を通る（BlockEditor は key={note.id} で再マウントされる
// ため、ロード後の effect で消費する）。
let pending: { noteId: string; blockId: string } | null = null;

export function setPendingBlockTarget(target: { noteId: string; blockId: string }) {
  pending = target;
}

/** noteId 宛の block target を取り出して消費する。別 note のロードでは温存。 */
export function takePendingBlockTarget(noteId: string): string | null {
  if (pending === null || pending.noteId !== noteId) return null;
  const { blockId } = pending;
  pending = null;
  return blockId;
}
