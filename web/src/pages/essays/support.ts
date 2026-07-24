import type { EssayStatus, NoteSummary } from "@/types.gen";

/** summary から essay の status を取り出す。essay 以外は現れない前提だが型上は防御する */
export function essayStatus(summary: NoteSummary): EssayStatus | null {
  return summary.kind.kind === "essay" ? summary.kind.status : null;
}

export function essayTitle(summary: NoteSummary): string {
  return summary.kind.kind === "essay" ? summary.kind.title : "";
}

/** `2026-07-21T…` → `2026/7/21`（ゼロ埋めなし。一覧カードの日付表記） */
export function slashDate(timestamp: string): string {
  const [y, m, d] = timestamp.slice(0, 10).split("-");
  return `${y}/${Number(m)}/${Number(d)}`;
}
