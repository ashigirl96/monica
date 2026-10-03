import type { TerminalSession } from "./contract.ts";

// 起動してすぐ終わる shell（壊れた .zshrc など）を起こし続けないための下限。
const SHORTEST_LIFE_TO_RESPAWN_MS = 2000;

export function shouldRespawn(
  ended: Pick<TerminalSession, "status" | "pid" | "createdAt" | "endedAt">,
  tab: { pinned: boolean } | null,
): boolean {
  if (!tab?.pinned || (ended.status !== "exited" && ended.status !== "lost") || !ended.endedAt) {
    return false;
  }
  // pid の無い lost は Create が届く前に失われた行で、shell は一度も動いていない。
  if (ended.status === "lost" && ended.pid === null) return true;
  return ended.endedAt.getTime() - ended.createdAt.getTime() >= SHORTEST_LIFE_TO_RESPAWN_MS;
}
