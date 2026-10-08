import { table } from '@monica/ui/table'
import type { ContractRouterClient } from '@orpc/contract'

import type { AgentSession, contract, TerminalSession } from './contract.ts'

type Connect = (options: {
  retry: boolean
}) => { workbench: ContractRouterClient<typeof contract> } | null

export const commands = [
  {
    path: ['workbench', 'hook', 'claude'],
    description:
      'Pass a Claude Code hook from a Tab to its Agent Session (the payload comes on stdin)',
    run: hookClaude,
  },
] as const

// tool 1 回ごとに起動するので、contract や zod の実体を import しない。
async function hookClaude(_argv: string[], { connect }: { connect: Connect }): Promise<number> {
  const terminalSessionId = process.env.MONICA_TERMINAL_SESSION_ID
  if (!terminalSessionId) return 0
  // Backend の不在・失敗・timeout のどれでも claude を止めない。retry もしない（ADR-0007）。
  try {
    const payload = JSON.parse(await Bun.stdin.text())
    if (payload.hook_event_name === 'PermissionRequest' && payload.tool_name === 'ExitPlanMode') {
      await Bun.write(Bun.stdout, `${JSON.stringify(approvePlan(payload.tool_input))}\n`)
      return 0
    }
    await connect({ retry: false })?.workbench.agentSession.recordHook(
      { terminalSessionId, payload },
      { signal: AbortSignal.timeout(2000) },
    )
  } catch (error) {
    console.error(`monica workbench hook claude: ${error instanceof Error ? error.message : error}`)
  }
  return 0
}

// claude は tool_input を返さないとダイアログを閉じず、mode を付けないと plan mode から acceptEdits に落ちる。
function approvePlan(toolInput: unknown) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: toolInput,
        updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }],
      },
    },
  }
}

export const formatters = {
  terminalSession: {
    list(sessions: TerminalSession[]): string {
      if (sessions.length === 0) return 'No live Terminal Sessions'
      return table([
        ['ID', 'STATUS', 'PID', 'CWD'],
        ...sessions.map((s) => [s.id, s.status, s.pid === null ? '-' : String(s.pid), s.cwd]),
      ])
    },
  },
  agentSession: {
    list(sessions: AgentSession[]): string {
      if (sessions.length === 0) return 'No live Agent Sessions'
      return table([
        ['ID', 'TERMINAL SESSION', 'STATE', 'CWD'],
        ...sessions.map((s) => [s.sessionId.slice(0, 8), s.terminalSessionId, stateOf(s), s.cwd]),
      ])
    },
  },
}

function stateOf(session: AgentSession): string {
  if (session.state !== 'waiting') return session.state
  const detail = session.waitReason === 'permission' ? session.waitTool : session.errorType
  return detail ? `waiting (${session.waitReason}: ${detail})` : `waiting (${session.waitReason})`
}
