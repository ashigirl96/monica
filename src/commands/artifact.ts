import { commands } from "./bindings";
import type { ArtifactDraftKind, ArtifactKind, TimelineCursor } from "./bindings";
import { unwrap } from "./unwrap";

export type {
  Artifact,
  ArtifactDraft,
  ArtifactDraftKind,
  ArtifactKind,
  Attachment,
  EssayListItem,
  IntentGroup,
  TimelineCursor,
  TimelineItem,
} from "./bindings";

export function createDraft(kind: ArtifactDraftKind) {
  return unwrap(commands.createDraft(kind));
}

export function updateDraft(
  id: string,
  kind: ArtifactDraftKind,
  body: string,
  occurredAt: string | null,
  expectedRevision: number,
) {
  return unwrap(commands.updateDraft(id, kind, body, occurredAt, expectedRevision));
}

export function listDrafts() {
  return unwrap(commands.listDrafts());
}

export function saveDraft(id: string) {
  return unwrap(commands.saveDraft(id));
}

export function getArtifact(id: string) {
  return unwrap(commands.getArtifact(id));
}

export function updateArtifact(
  id: string,
  kind: ArtifactKind,
  body: string,
  occurredAt: string | null,
  expectedRevision: number,
) {
  return unwrap(commands.updateArtifact(id, kind, body, occurredAt, expectedRevision));
}

export function deleteDraft(id: string) {
  return unwrap(commands.deleteDraft(id));
}

export function convertArtifactKind(
  id: string,
  targetKind: ArtifactKind,
  expectedRevision: number,
) {
  return unwrap(commands.convertArtifactKind(id, targetKind, expectedRevision));
}

export function deleteArtifact(id: string) {
  return unwrap(commands.deleteArtifact(id));
}

export function listEssays() {
  return unwrap(commands.listEssays());
}

export function listIntentsByProject() {
  return unwrap(commands.listIntentsByProject());
}

export function listTimelineItems(
  before: TimelineCursor | null,
  since: string | null,
  limit: number,
) {
  return unwrap(commands.listTimelineItems(before, since, limit));
}

export function attachImage(entryId: string, filePath: string) {
  return unwrap(commands.attachImage(entryId, filePath));
}

export function removeAttachment(id: string) {
  return unwrap(commands.removeAttachment(id));
}
