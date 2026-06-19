import type { ArtifactDraftKind, ArtifactKind } from "@/commands/artifact";

type WriterKind = ArtifactDraftKind | ArtifactKind;

export function titleFromKind(kind: WriterKind): string {
  return kind.type === "memo" ? "" : (kind.title ?? "");
}

export function projectIdFromKind(kind: WriterKind): string | null {
  return kind.type === "intent" ? (kind.project_id ?? null) : null;
}

export function buildDraftKind(
  existing: WriterKind,
  title: string,
  projectId: string | null,
): ArtifactDraftKind {
  switch (existing.type) {
    case "essay":
      return { type: "essay", title: title || null };
    case "intent":
      return { type: "intent", title: title || null, project_id: projectId };
    default:
      return { type: "memo" };
  }
}

export function buildArtifactKind(
  existing: WriterKind,
  title: string,
  projectId: string | null,
): ArtifactKind {
  switch (existing.type) {
    case "essay":
      return { type: "essay", title: title.trim() || "" };
    case "intent":
      return { type: "intent", title: title.trim() || "", project_id: projectId };
    default:
      return { type: "memo" };
  }
}

export function occurredAtToDateTimeLocalValue(occurredAt: string | null): string {
  if (!occurredAt) return "";
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) return "";
  const localTime = date.getTime() - date.getTimezoneOffset() * 60_000;
  return new Date(localTime).toISOString().slice(0, 16);
}

export function dateTimeLocalValueToOccurredAt(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
