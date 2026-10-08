import { atom } from 'jotai'

import type { TerminalSession } from '../contract.ts'

export type TerminalSessionStatus = TerminalSession['status']

export type TerminalSessionStatusEntry = {
  status: TerminalSessionStatus
  exitCode?: number | null
}

export function isDeadStatus(status: TerminalSessionStatus | undefined): boolean {
  return status === 'exited' || status === 'lost' || status === 'failed'
}

// starting の Terminal Session は ptyd にまだ無いことがあり、attach すると失敗して lost に見えるので、running を待つ。
export function canAttach(status: TerminalSessionStatus | undefined): boolean {
  return status !== 'starting' && !isDeadStatus(status)
}

// 読み直しの合間は pane が attach と Exit で知った状態を書き込み、map に無い Terminal Session は不明として pane が attach を試みる。
export const terminalSessionStatusAtom = atom<Record<string, TerminalSessionStatusEntry>>({})

export const setTerminalSessionStatusAtom = atom(
  null,
  (_get, set, terminalSessionId: string, entry: TerminalSessionStatusEntry) => {
    set(terminalSessionStatusAtom, (prev) => ({ ...prev, [terminalSessionId]: entry }))
  },
)

// Exit を受けた Terminal Session は、Backend が exit を記録するまで一覧では live のままなので、exited として扱う。
const endedAtom = atom<ReadonlySet<string>>(new Set<string>())

export const markEndedAtom = atom(null, (_get, set, terminalSessionId: string) => {
  set(endedAtom, (prev) => new Set(prev).add(terminalSessionId))
})

export const applyTerminalSessionListAtom = atom(
  null,
  (get, set, terminalSessions: TerminalSession[]) => {
    const ended = get(endedAtom)
    const previous = get(terminalSessionStatusAtom)
    const live = new Set(terminalSessions.filter((s) => !isDeadStatus(s.status)).map((s) => s.id))
    set(
      terminalSessionStatusAtom,
      Object.fromEntries(
        terminalSessions.map((s): [string, TerminalSessionStatusEntry] => [
          s.id,
          live.has(s.id) && ended.has(s.id)
            ? { status: 'exited', exitCode: previous[s.id]?.exitCode ?? null }
            : { status: s.status, exitCode: s.exitCode },
        ]),
      ),
    )
    if ([...ended].some((id) => !live.has(id))) {
      set(endedAtom, new Set([...ended].filter((id) => live.has(id))))
    }
  },
)
