import { relayRunButton } from './run-button-relay.ts'

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const reply = relayRunButton(__MONICA_NATIVE_HOST__, message)
  if (!reply) return false
  void reply.then(sendResponse)
  // 非同期に答えるときは true を返し、sendResponse の口を開けたままにする。
  return true
})
