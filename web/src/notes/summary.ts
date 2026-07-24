import type { NoteSummary } from "@/types.gen";

/** サイドバー / カード一覧の 1 行見出し。title を持つ kind（essay / project）は
 * 非空 title を優先し、無題や daily は本文プレビューへフォールバックする。 */
export function summaryTitle(summary: NoteSummary): string {
  const kind = summary.kind;
  if (kind.kind === "essay" && kind.title !== "") return kind.title;
  if (kind.kind === "project" && kind.title !== "") return kind.title;
  return summary.preview ?? "Untitled";
}
