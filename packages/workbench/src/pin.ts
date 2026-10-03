import type { TerminalSession } from "./contract.ts";

// 起動してすぐ終わる shell（壊れた .zshrc など）を起こし続けないための下限。
const SHORTEST_LIFE_TO_RESPAWN_MS = 2000;

export function shouldRespawn(
  ended: Pick<TerminalSession, "status" | "createdAt" | "endedAt">,
  tab: { pinned: boolean } | null,
): boolean {
  if (!tab?.pinned || (ended.status !== "exited" && ended.status !== "lost") || !ended.endedAt) {
    return false;
  }
  return ended.endedAt.getTime() - ended.createdAt.getTime() >= SHORTEST_LIFE_TO_RESPAWN_MS;
}
