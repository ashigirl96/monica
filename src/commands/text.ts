import { commands } from "./bindings";
import type { ArtifactType, CreateArtifactInput, UpdateArtifactInput } from "./bindings";

export type {
  Artifact,
  ArtifactSummary,
  ArtifactType,
  ArtifactTypeOption,
  CreateArtifactInput,
  IntentSeedStatusOption,
  TextExportResult,
  UpdateArtifactInput,
} from "./bindings";

async function unwrap<T>(
  result: Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>,
): Promise<T> {
  const r = await result;
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

export function listTextArtifacts(artifactType: ArtifactType | null, query: string | null) {
  return unwrap(commands.listTextArtifacts(artifactType, query));
}

export function getTextArtifact(id: string) {
  return unwrap(commands.getTextArtifact(id));
}

export function createTextArtifact(input: CreateArtifactInput) {
  return unwrap(commands.createTextArtifact(input));
}

export function updateTextArtifact(input: UpdateArtifactInput) {
  return unwrap(commands.updateTextArtifact(input));
}

export function promoteTextRecordToIntentSeed(recordId: string) {
  return unwrap(commands.promoteTextRecordToIntentSeed(recordId));
}

export function textArtifactTypeOptions() {
  return commands.textArtifactTypeOptionsCommand();
}

export function intentSeedStatusOptions() {
  return commands.intentSeedStatusOptionsCommand();
}

export function exportPersonalSpace() {
  return unwrap(commands.exportPersonalSpace());
}
