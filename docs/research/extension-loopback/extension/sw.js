import { holdStreams, loadConfig, report, runProbes } from './probe.js'

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  const cfg = await loadConfig()
  await report(cfg, { ctx: 'sw', event: 'installed' })
  await runProbes('sw', cfg)
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void loadConfig().then(async (cfg) => {
    if (message.type === 'probe') sendResponse(await runProbes('sw', cfg))
    if (message.type === 'hold') {
      await report(cfg, { ctx: 'sw', event: 'hold' })
      holdStreams('sw', cfg)
      sendResponse('holding')
    }
  })
  return true
})
