import { listen } from '@tauri-apps/api/event'
import type { Store } from 'jotai'

import { shell } from './shell.ts'
import { layoutAtom, showTerminalSessionAtom, warnFailed } from './store.ts'

// 通知で起こした tania ではクリックが listen より先に届くので、Shell が持っているものを listen を張ってから取り出す。
// 取り出すと Shell から消えるので、effect を片付けた後に届いた答えも捨てずに Tab を選ぶ。
export function followNotificationClicks(store: Store): () => void {
  const take = () =>
    shell<string | null>('take_notification_click', {})
      .then((terminalSessionId) => {
        if (terminalSessionId) showOnceLaidOut(store, terminalSessionId)
      })
      .catch((e: unknown) => warnFailed('take a notification click', e))
  const unlisten = listen('notification-clicked', () => void take())
  void unlisten.then(take, (e: unknown) => warnFailed('listen for notification clicks', e))
  return () => void unlisten.then((stop) => stop()).catch(() => {})
}

function showOnceLaidOut(store: Store, terminalSessionId: string) {
  const show = () => store.set(showTerminalSessionAtom, terminalSessionId)
  if (store.get(layoutAtom)) return show()
  const stop = store.sub(layoutAtom, () => {
    if (!store.get(layoutAtom)) return
    stop()
    show()
  })
}
