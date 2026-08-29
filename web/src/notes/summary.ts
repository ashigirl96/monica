import type { Note, NoteSummary } from "@/types.gen";

/** サイドバー / カード一覧の 1 行見出し。title を持つ kind（essay / project）は
 * 非空 title を優先し、無題や daily は本文プレビューへフォールバックする。 */
export function summaryTitle(summary: NoteSummary): string {
  const kind = summary.kind;
  if (kind.kind === "essay" && kind.title !== "") return kind.title;
  if (kind.kind === "project" && kind.title !== "") return kind.title;
  return summary.preview ?? "Untitled";
}

/** 競合通知のように、開いていない note を名指しするときの短い見出し。title を持つ kind は
 * 非空 title を、持たない kind（daily）や無題は呼び手の fallback を使う（本文プレビューは
 * 手元に無いので summaryTitle とは別経路）。 */
export function noteLabel(note: Note, fallback: string): string {
  const kind = note.kind;
  if ((kind.kind === "essay" || kind.kind === "project") && kind.title !== "") return kind.title;
  return fallback;
}
