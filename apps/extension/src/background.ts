import {
  injectPageTranslation,
  relayPageTranslation,
  PAGE_TRANSLATION_COMMAND,
} from '@monica/chat/page-translation-relay'
import { savedChatKey } from '@monica/chat/saved-chat'

import pageTranslation from './page-translation.ts?script&iife'
import { relayRunButton } from './run-button-relay.ts'

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

// 閉じた window の Chat は二度と開かれないので、storage.session の枠を空ける。
chrome.windows.onRemoved.addListener((windowId) => {
  void chrome.storage.session.remove(savedChatKey(windowId))
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const reply =
    relayRunButton(__MONICA_NATIVE_HOST__, message) ??
    relayPageTranslation(__MONICA_NATIVE_HOST__, message, sender)
  if (!reply) return false
  void reply.then(sendResponse)
  // 非同期に答えるときは true を返し、sendResponse の口を開けたままにする。
  return true
})

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === PAGE_TRANSLATION_COMMAND && tab?.id !== undefined) {
    void injectPageTranslation(tab.id, pageTranslation)
  }
})
