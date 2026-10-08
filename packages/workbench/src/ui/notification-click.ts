import { listen } from '@tauri-apps/api/event'
import type { Store } from 'jotai'

import { layoutAtom } from './backend-copy.ts'
import { showTerminalSessionAtom } from './navigation.ts'
import { shell } from './shell.ts'
import { reloadAtom, warnFailed } from './store.ts'

// 通知で起こした monica ではクリックが listen より先に届くので、Shell が持っているものを listen を張ってから取り出す。
// 取り出すと Shell から消えるので、effect を片付けた後に届いた答えも捨てずに Tab を選ぶ。
export function followNotificationClicks(store: Store): () => void {
  const take = () =>
    shell<string | null>('take_notification_click', {})
      .then((terminalSessionId) => {
        if (terminalSessionId) showInLatestLayout(store, terminalSessionId)
      })
      .catch((e: unknown) => warnFailed('take a notification click', e))
  const unlisten = listen('notification-clicked', () => void take())
  void unlisten.then(take, (e: unknown) => warnFailed('listen for notification clicks', e))
  return () => void unlisten.then((stop) => stop()).catch(() => {})
}

// 窓が隠れている間は webview が layout を読み直せず、その間に開いた Tab が載っていないので、読み直してから照合する。
function showInLatestLayout(store: Store, terminalSessionId: string) {
  store.set(reloadAtom).then(
    () => store.set(showTerminalSessionAtom, terminalSessionId),
    // Backend が居ない間も layout は前の値のまま残るので、繋がって次に読めた layout で照合する。
    () => showInNextLayout(store, terminalSessionId),
  )
}

function showInNextLayout(store: Store, terminalSessionId: string) {
  const stop = store.sub(layoutAtom, () => {
    if (!store.get(layoutAtom)) return
    stop()
    store.set(showTerminalSessionAtom, terminalSessionId)
  })
}
