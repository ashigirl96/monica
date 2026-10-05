import type { DisplayState } from './contract.ts'

export function stateText(displayState: DisplayState): string {
  if (!('liveRuns' in displayState)) return displayState.state
  const head =
    displayState.state === 'waiting'
      ? `waiting:${displayState.reason}${displayState.tool ? `(${displayState.tool})` : ''}`
      : displayState.state
  const others = displayState.liveRuns.length - 1
  return `${head} ${age(displayState.since)}${others > 0 ? ` +${others}` : ''}`
}

function age(since: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - since.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}
