import type { NoteKind } from "@/types.gen";

// 表示順のみをここで決める。値の集合は Rust の NoteKind が source of truth で、
// variant が増減すると下の網羅性チェックが型エラーになる。
export const NOTE_KINDS = ["memo", "journaling", "essay"] as const satisfies readonly NoteKind[];

type MissingKind = Exclude<NoteKind, (typeof NOTE_KINDS)[number]>;
const _allKindsListed: MissingKind extends never ? true : never = true;
void _allKindsListed;

export function kindColor(kind: NoteKind): string {
  switch (kind) {
    case "journaling":
      return "var(--kind-journaling)";
    case "essay":
      return "var(--kind-essay)";
    default:
      return "var(--ink-muted)";
  }
}
