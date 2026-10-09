import type { TerminalSession } from './contract.ts'

export const LIVE = ['starting', 'running'] as const

export function isLive(status: TerminalSession['status']): boolean {
  return (LIVE as readonly string[]).includes(status)
}
