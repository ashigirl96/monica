import { type MouseEvent, useSyncExternalStore } from 'react'

function subscribe(cb: () => void) {
  window.addEventListener('popstate', cb)
  return () => window.removeEventListener('popstate', cb)
}

function getSnapshot() {
  return window.location.pathname
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, getSnapshot)
}

export function navigate(to: string, opts?: { replace?: boolean }) {
  if (opts?.replace) {
    window.history.replaceState(null, '', to)
  } else {
    window.history.pushState(null, '', to)
  }
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** <a> の onClick 用。修飾キー付きクリック（新規タブ等のネイティブ挙動）は素通しして SPA 遷移する */
export function spaLinkClick(to: string) {
  return (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
}
