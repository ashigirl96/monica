import { pushErrorToast } from '@monica/ui'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { Terminal } from '@xterm/xterm'
import { getDefaultStore } from 'jotai'
import { useEffect } from 'react'

import { shell } from './shell.ts'
import { activeTerminalTabAtom } from './store.ts'
import { getTabTerminal } from './terminal-connections.ts'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.tiff', '.bmp']

function isImage(path: string): boolean {
  const lower = path.toLowerCase()
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function clipboardWriteImage(path: string): Promise<void> {
  return shell('clipboard_write_image', { path })
}

// xterm に encode させれば、app が kitty の flag を立てているときだけ `CSI 118;5u` になり、shell には `\x16` が届く。
function pressCtrlV(term: Terminal): void {
  const event = new KeyboardEvent('keydown', {
    key: 'v',
    code: 'KeyV',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  // KeyboardEventInit は keyCode を受け取らないが、xterm の legacy の encode は keyCode を読む。
  Object.defineProperty(event, 'keyCode', { value: 86 })
  term.textarea?.dispatchEvent(event)
}

// Ctrl+V で clipboard の画像を読むのは agent の振る舞いなので、clipboard に置くのと貼るのを分けて呼ぶ。
export async function pasteDroppedImage(paths: readonly string[], paste: () => void) {
  const image = paths.find(isImage)
  if (!image) return
  try {
    await clipboardWriteImage(image)
  } catch (e) {
    pushErrorToast(`Image drop failed: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  paste()
}

export function useImageDrop() {
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return
      const tab = getDefaultStore().get(activeTerminalTabAtom)
      const term = tab && getTabTerminal(tab.id)
      if (!term) return
      void pasteDroppedImage(event.payload.paths, () => pressCtrlV(term))
    })
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [])
}
