import { preview } from '../../body/index.ts'
import type { Doc, Note, NoteSummary } from '../../contract.ts'

/** サイドバーの 1 行の見出し。title を持つ kind は非空 title を優先し、
 * 無題や title の無い kind は本文の preview へ、それも無ければ Untitled へ倒す。 */
export function summaryTitle(summary: NoteSummary): string {
  if ((summary.kind === 'essay' || summary.kind === 'repo_note') && summary.title !== '') {
    return summary.title
  }
  return summary.preview || 'Untitled'
}

/** 保存した本文の preview を一覧に写す。Backend が保存のたびに作り直すものと同じ関数で作る。 */
export function withSavedPreview<T extends NoteSummary>(
  list: T[] | undefined,
  id: string,
  content: Doc,
): T[] | undefined {
  return list?.map((s) => (s.id === id ? { ...s, preview: preview(content) } : s))
}

/** 競合通知のように、開いていない note を名指しするときの短い見出し。title を持つ kind は
 * 非空 title を、持たない kind（daily）や無題は呼び手の fallback を使う（本文プレビューは
 * 手元に無いので summaryTitle とは別経路）。 */
export function noteLabel(note: Note, fallback: string): string {
  if ((note.kind === 'essay' || note.kind === 'repo_note') && note.title !== '') return note.title
  return fallback
}
