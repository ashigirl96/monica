import { getCurrentWindow } from '@tauri-apps/api/window'
import { atom, type Store } from 'jotai'

import {
  activeTerminalTabAtom,
  agentSessionByTerminalSessionAtom,
  warnFailed,
  workbenchClientAtom,
} from './store.ts'

export const windowFocusedAtom = atom(false)

const unreadInFrontAtom = atom((get) => {
  const tab = get(activeTerminalTabAtom)
  const agentSession = tab && get(agentSessionByTerminalSessionAtom).get(tab.terminalSessionId)
  return get(windowFocusedAtom) && agentSession?.unread ? agentSession : null
})

// Agent Session は読み直すたびに別の値になるので、見たと伝えた後に届いた通知も、表示している間なら見たことにする。
export function markSeenWhileShown(store: Store): () => void {
  const markSeen = () => {
    const agentSession = store.get(unreadInFrontAtom)
    const client = store.get(workbenchClientAtom)
    if (!agentSession?.notifiedAt || !client) return
    client.agentSession
      .markSeen({ sessionId: agentSession.sessionId, notifiedAt: agentSession.notifiedAt })
      .catch((e: unknown) => warnFailed('mark seen', e))
  }
  markSeen()
  return store.sub(unreadInFrontAtom, markSeen)
}

export function followWindowFocus(store: Store): () => void {
  const appWindow = getCurrentWindow()
  let disposed = false
  let heard = false
  let unlisten: (() => void) | undefined
  void (async () => {
    try {
      const stop = await appWindow.onFocusChanged(({ payload }) => {
        heard = true
        store.set(windowFocusedAtom, payload)
      })
      if (disposed) return stop()
      unlisten = stop
      const focused = await appWindow.isFocused()
      // 読む間に届いた event のほうが新しいので、そのときは読んだ値を捨てる。
      if (!disposed && !heard) store.set(windowFocusedAtom, focused)
    } catch (e) {
      warnFailed('window focus', e)
    }
  })()
  return () => {
    disposed = true
    unlisten?.()
  }
}
