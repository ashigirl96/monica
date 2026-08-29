/** 409 で行き場を失った編集を抱えている note 1 件。label は通知に出す見出し
 * （kind ごとの決め方はページの知識なので、schedule 時に受け取る）。 */
export type NoteConflict = { id: string; label: string };

/** 同じ note の再競合は 1 行に畳み、label だけ最新へ更新する。並び順を動かさないのは、
 * 押そうとしたボタンが別 note のものに入れ替わるのを避けるため。 */
export function upsertConflict(list: NoteConflict[], entry: NoteConflict): NoteConflict[] {
  if (!list.some((c) => c.id === entry.id)) return [...list, entry];
  return list.map((c) => (c.id === entry.id ? entry : c));
}

export function removeConflict(list: NoteConflict[], id: string): NoteConflict[] {
  return list.filter((c) => c.id !== id);
}

/** 通知に出す行。開いている note はヘッダのインラインバナーが担当するので除く。 */
export function visibleConflicts(list: NoteConflict[], openNoteId: string | null): NoteConflict[] {
  return openNoteId === null ? list : list.filter((c) => c.id !== openNoteId);
}

/**
 * 基準版を next へ進めてよいか。
 *
 * 単調にしか進めない: 巻き戻すと偽の 409 か、古い doc での静かな上書きに直結する。
 *
 * 加えて、競合が未解決の間は進めない。競合した note を開き直すと `useServerDoc` の
 * mount 分岐（latch がまだ空なので無条件に adopt する）が勝者の doc を採用し、そのまま
 * だと基準版が競合を跨いで前進する。すると行き場を失った draft を抱えたまま PUT が通る
 * ようになり、競合を解決しないまま勝者の変更を上書きしてしまう。ピンが解けるのは
 * 「最新を読み込む」（dropPending）と削除（discard）だけ。
 */
export function shouldAdvanceBase(
  current: string | null,
  next: string,
  conflicted: boolean,
): boolean {
  if (conflicted) return false;
  return current === null || next > current;
}
