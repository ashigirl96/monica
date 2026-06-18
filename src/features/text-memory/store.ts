import { atom } from "jotai";
import type { ArtifactType } from "@/commands/text";
import { activeSpaceAtom } from "@/stores/space";

export type TextViewMode = "all" | "record" | "intent_seed";

export const textViewModeAtom = atom<TextViewMode>("record");
export const textRefreshTokenAtom = atom(0);
export const captureOpenAtom = atom(false);
export const captureDraftTypeAtom = atom<ArtifactType>("record");

export const bumpTextRefreshAtom = atom(null, (get, set) => {
  set(textRefreshTokenAtom, get(textRefreshTokenAtom) + 1);
});

export const openCaptureAtom = atom(null, (get, set, artifactType?: ArtifactType) => {
  const activeSpace = get(activeSpaceAtom);
  const viewMode = get(textViewModeAtom);
  const inferredType =
    artifactType ??
    (activeSpace === "personal" && viewMode === "intent_seed" ? "intent_seed" : "record");
  set(captureDraftTypeAtom, inferredType);
  set(captureOpenAtom, true);
});
