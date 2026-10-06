import type { CloseRefusal } from './contract.ts'

// CLI は理由を 1 行ずつ、webview の toast は 1 行にまとめて出すので、語だけをここで作る。
export function describeRefusal(ref: string, reasons: CloseRefusal[]) {
  return { headline: `${ref} stays open:`, reasons: reasons.map(reasonLine) }
}

function reasonLine(reason: CloseRefusal): string {
  switch (reason.kind) {
    case 'active_run':
      return `claude ${reason.agentSessionId} is a live Run (${reason.state})`
    case 'uncommitted_changes':
      return `the worktree ${reason.worktree} has uncommitted changes`
    case 'unpublished_commits':
      return `branch ${reason.branch} has commits on no remote`
  }
}
