import type { ChatStore, SavedChat } from './chat-store.ts'

export const savedChatKey = (windowId: number) => `monica-chat-${windowId}`

const SAVE_EVERY_MS = 500

/**
 * side panel を閉じても「新しい Chat」までは続くよう、window ごとの Chat を storage に写し、開いた時に戻す。
 * storage.session は memory にだけあり、browser を終えると消える。
 */
export function keepChat(
  store: ChatStore,
  storage: chrome.storage.StorageArea,
  windowId: number,
): () => void {
  const key = savedChatKey(windowId)
  let stopped = false
  let pending: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined

  // 写せなかった時に古い Chat を戻さないよう、残したものを消す。
  const save = () => {
    pending = undefined
    void storage
      .set({ [key]: store.saved() })
      .catch(() => storage.remove(key))
      .catch(() => {})
  }

  // 戻す前に空の Chat を写さないよう、読み終えてから写し始める。
  void storage
    .get(key)
    .catch(() => ({}) as Record<string, unknown>)
    .then((items) => {
      if (stopped) return
      const saved = items[key] as SavedChat | undefined
      if (saved) store.restore(saved)
      // 答えの stream の event ごとには写さず、間を空けて最新を写す。
      unsubscribe = store.subscribe(() => {
        pending ??= setTimeout(save, SAVE_EVERY_MS)
      })
    })

  return () => {
    stopped = true
    unsubscribe?.()
    clearTimeout(pending)
  }
}
