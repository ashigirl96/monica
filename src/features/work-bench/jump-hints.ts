import { atom } from "jotai";
import {
  activateRunspaceAtom,
  activateTerminalTabAtom,
  activeRunspaceAtom,
  runspaceSummariesAtom,
} from "@/features/work-bench/store";

export const jumpHintsActiveAtom = atom(false);

// Both use digits in visual order; Ctrl disambiguates runspace (⌃1) from tab (1).
const HINT_KEYS = [..."123456789"];

type JumpHintTargets = {
  byRunspaceId: Record<string, string>;
  byTabId: Record<string, string>;
};

const NO_HINT_TARGETS: JumpHintTargets = { byRunspaceId: {}, byTabId: {} };

export const jumpHintTargetsAtom = atom((get): JumpHintTargets => {
  if (!get(jumpHintsActiveAtom)) return NO_HINT_TARGETS;
  const summaries = get(runspaceSummariesAtom);
  // Hint order must match the sidebar's visual order: task-bound group first, then shells.
  const ordered = [...summaries.filter((s) => s.taskId), ...summaries.filter((s) => !s.taskId)];
  const rs = get(activeRunspaceAtom);
  const tabs = rs ? [...rs.tabs].sort((a, b) => a.order - b.order) : [];

  const byRunspaceId: Record<string, string> = {};
  const byTabId: Record<string, string> = {};
  ordered.slice(0, HINT_KEYS.length).forEach((s, i) => {
    byRunspaceId[s.id] = HINT_KEYS[i];
  });
  tabs.slice(0, HINT_KEYS.length).forEach((t, i) => {
    byTabId[t.id] = HINT_KEYS[i];
  });
  return { byRunspaceId, byTabId };
});

export const jumpToHintAtom = atom(null, (get, set, input: { key: string; runspace: boolean }) => {
  // Read before dismissing: the targets atom empties once hints deactivate.
  const targets = get(jumpHintTargetsAtom);
  set(jumpHintsActiveAtom, false);
  const byId = input.runspace ? targets.byRunspaceId : targets.byTabId;
  const match = Object.entries(byId).find(([, key]) => key === input.key);
  if (!match) return;
  if (input.runspace) {
    set(activateRunspaceAtom, match[0]);
  } else {
    set(activateTerminalTabAtom, match[0]);
  }
});
