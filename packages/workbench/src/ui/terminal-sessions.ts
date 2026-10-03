import { atom } from "jotai";
import type { TerminalSession } from "../contract.ts";

export type TerminalSessionStatus = TerminalSession["status"];

export type TerminalSessionStatusEntry = {
  status: TerminalSessionStatus;
  exitCode?: number | null;
};

export function isDeadStatus(status: TerminalSessionStatus | undefined): boolean {
  return status === "exited" || status === "lost" || status === "failed";
}

const terminalSessionsAtom = atom<TerminalSession[]>([]);

// 読み直しの合間は pane が attach と Exit で知った状態を書き込み、map に無い Terminal Session は不明として pane が attach を試みる。
export const terminalSessionStatusAtom = atom<Record<string, TerminalSessionStatusEntry>>({});

export const setTerminalSessionStatusAtom = atom(
  null,
  (_get, set, terminalSessionId: string, entry: TerminalSessionStatusEntry) => {
    set(terminalSessionStatusAtom, (prev) => ({ ...prev, [terminalSessionId]: entry }));
  },
);

// 終了を頼んでから ptyd が exit を報告するまで、行は live のまま Tab を失うので Detached に出さない。
const terminatingAtom = atom<ReadonlySet<string>>(new Set<string>());

export const markTerminatingAtom = atom(null, (_get, set, terminalSessionId: string) => {
  set(terminatingAtom, (prev) => new Set(prev).add(terminalSessionId));
});

export const detachedTerminalSessionsAtom = atom((get) => {
  const terminating = get(terminatingAtom);
  return get(terminalSessionsAtom).filter(
    (s) => !isDeadStatus(s.status) && s.tabId === null && !terminating.has(s.id),
  );
});

export const applyTerminalSessionListAtom = atom(
  null,
  (get, set, terminalSessions: TerminalSession[]) => {
    set(terminalSessionsAtom, terminalSessions);
    set(
      terminalSessionStatusAtom,
      Object.fromEntries(
        terminalSessions.map((s) => [s.id, { status: s.status, exitCode: s.exitCode }]),
      ),
    );
    const live = new Set(terminalSessions.filter((s) => !isDeadStatus(s.status)).map((s) => s.id));
    const terminating = get(terminatingAtom);
    if ([...terminating].some((id) => !live.has(id))) {
      set(terminatingAtom, new Set([...terminating].filter((id) => live.has(id))));
    }
  },
);
