import type { NoteKind } from "@/types.gen";

/** discriminant のみ（"project" | "daily" | "essay"）。値の集合は Rust の NoteKind が
 * source of truth で、variant が増減すると下の switch が型エラーになる。 */
export type NoteKindName = NoteKind["kind"];

export function kindColor(kind: NoteKindName): string {
  switch (kind) {
    case "daily":
      return "var(--kind-daily)";
    case "essay":
      return "var(--kind-essay)";
    case "project":
      return "var(--ink-muted)";
  }
}
