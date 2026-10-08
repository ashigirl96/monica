import { atom } from 'jotai'

import type { Layout, ListedAgentSession, RepoPlace } from '../contract.ts'
import { agentDotOf } from './agent-dot.ts'

export const layoutAtom = atom<Layout | null>(null)

export const runspacesAtom = atom((get) => get(layoutAtom)?.runspaces ?? [])

export const agentSessionsAtom = atom<ListedAgentSession[]>([])

export const agentSessionByTerminalSessionAtom = atom(
  (get) => new Map(get(agentSessionsAtom).map((a) => [a.terminalSessionId, a])),
)

export const agentDotOfTerminalSessionAtom = atom((get) => {
  const byTerminalSession = get(agentSessionByTerminalSessionAtom)
  return (terminalSessionId: string) => agentDotOf(byTerminalSession.get(terminalSessionId))
})

export const unreadOfTerminalSessionAtom = atom((get) => {
  const byTerminalSession = get(agentSessionByTerminalSessionAtom)
  return (terminalSessionId: string) => byTerminalSession.get(terminalSessionId)?.unread ?? false
})

export const placesAtom = atom<Record<string, RepoPlace>>({})
