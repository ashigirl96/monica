import { nextZoom, ZOOM_STEPS, type ZoomStep } from '@monica/ui'

const STORAGE_KEY = 'monica-chat-zoom'

export type ZoomKey = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey'>

/** ⌘+ は US 配列で ⇧ を伴うので、⇧ は問わない。 */
export function zoomStepOf(e: ZoomKey): ZoomStep | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
  // JIS 配列は ; のキーに + があり、Chrome はそこでの ⌘; を拡大として扱う。
  if (['+', '=', ';'].includes(e.key) || e.code === 'NumpadAdd') return 'in'
  if (e.key === '-' || e.code === 'NumpadSubtract') return 'out'
  if (e.key === '0' || e.code === 'Numpad0') return 'reset'
  return null
}

/**
 * Chrome は side panel を ⌘+・⌘-・⌘0 で拡大しないので、自分で受けて --chat-zoom に流す。
 * 入力欄で打っていても取るよう、window の capture phase で受ける。
 */
export function zoomOnKeys(): void {
  const stored = Number(localStorage.getItem(STORAGE_KEY))
  let zoom = ZOOM_STEPS.includes(stored) ? stored : 1
  const apply = () => document.documentElement.style.setProperty('--chat-zoom', String(zoom))
  apply()
  window.addEventListener(
    'keydown',
    (e) => {
      const step = zoomStepOf(e)
      if (step === null) return
      e.preventDefault()
      zoom = nextZoom(zoom, step)
      apply()
      localStorage.setItem(STORAGE_KEY, String(zoom))
    },
    true,
  )
}
