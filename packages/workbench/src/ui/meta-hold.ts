import { atom, type Store } from 'jotai'

// ⌘C や ⌘V のように続けてキーを押すときは、名前を出す前に消せるよう少し待つ。
const HOLD_MS = 100

export const metaHeldAtom = atom(false)

// xterm が key を握りつぶす前に見るので、capture で聞く。
export function followMetaHold(store: Store): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const release = () => {
    clearTimeout(timer)
    timer = undefined
    store.set(metaHeldAtom, false)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Meta' && e.repeat) return
    release()
    if (e.key !== 'Meta' || e.ctrlKey || e.altKey || e.shiftKey) return
    timer = setTimeout(() => store.set(metaHeldAtom, true), HOLD_MS)
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Meta') release()
  }
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('pointerdown', release, true)
  window.addEventListener('blur', release)
  return () => {
    release()
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('pointerdown', release, true)
    window.removeEventListener('blur', release)
  }
}
