export type KeyPress = Pick<
  KeyboardEvent,
  'code' | 'key' | 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'isComposing'
>

// macOS の ⌥N は dead key になり key が Dead になるので、code で見る。
export function isNewConversationKey(e: KeyPress): boolean {
  return e.code === 'KeyN' && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.isComposing
}

/** editor より先に受けるよう、window の capture phase で取る。 */
export function listenNewConversationKey(onPress: () => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isNewConversationKey(e)) return
    e.preventDefault()
    e.stopPropagation()
    onPress()
  }
  window.addEventListener('keydown', onKeyDown, true)
  return () => window.removeEventListener('keydown', onKeyDown, true)
}
