const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift'])

export type JumpModeActions = {
  deactivate: () => void
  createTab: () => void
  closeTab: () => void
  jumpToHint: (params: { key: string; runspace: boolean }) => void
  moveActiveTab: (direction: 'left' | 'right') => void
  moveActiveRunspace: (direction: 'up' | 'down') => void
}

export function handleJumpMode(
  e: KeyboardEvent,
  actions: JumpModeActions,
  { closing }: { closing: boolean },
): void {
  if (MODIFIER_KEYS.has(e.key)) return

  e.preventDefault()

  if (e.key === 'd' && !e.ctrlKey) {
    // 長押しの自動の繰り返しを 2 度目の d と数えると、確認を待たずに claude の居る Tab を閉じる。
    if (!e.repeat) actions.closeTab()
    return
  }

  // 2 度目の d を待つ間は hint を隠しているので、ほかのキーは見えない hint へ移らずに取り消すだけにする。
  if (closing || (e.ctrlKey && e.key === 't')) {
    actions.deactivate()
    return
  }

  if (e.key === 'c' && !e.ctrlKey) {
    actions.deactivate()
    actions.createTab()
    return
  }

  if (e.key === 'H' || e.key === 'L') {
    actions.moveActiveTab(e.key === 'H' ? 'left' : 'right')
    return
  }

  if (e.key === 'J' || e.key === 'K') {
    actions.moveActiveRunspace(e.key === 'K' ? 'up' : 'down')
    return
  }

  actions.jumpToHint({ key: e.key.toLowerCase(), runspace: e.ctrlKey })
}
