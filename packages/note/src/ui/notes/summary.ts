import type { Note } from '../../contract.ts'

/** サイドバーの 1 行見出し。無題は本文の 1 行目で見分ける。 */
export function summaryTitle(summary: { title: string; preview: string | null }): string {
  return summary.title || summary.preview || 'Untitled'
}

/** 競合通知のように、開いていない note を名指しするときの短い見出し。title を持つ kind は
 * 非空 title を、持たない kind（daily）や無題は呼び手の fallback を使う（本文プレビューは
 * 手元に無い）。 */
export function noteLabel(note: Note, fallback: string): string {
  if ((note.kind === 'essay' || note.kind === 'repo_note') && note.title !== '') return note.title
  return fallback
}
