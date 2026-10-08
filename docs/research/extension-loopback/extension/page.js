import { holdStreams, loadConfig, report, runProbes } from './probe.js'

const ctx = location.pathname.includes('panel') ? 'panel' : 'page'
const query = Object.fromEntries(new URLSearchParams(location.search))
if (Object.keys(query).length > 0) await chrome.storage.local.set({ cfg: query })
const cfg = await loadConfig()
const out = document.getElementById('out')

// sidePanel.open は user gesture の中で同期的に呼ぶので、windowId を先に取っておく。
const { id: windowId } = await chrome.windows.getCurrent()
document.getElementById('open-panel')?.addEventListener('click', () => {
  chrome.sidePanel.open({ windowId }).then(
    () => report(cfg, { ctx, event: 'sidePanel.open resolved' }),
    (error) => report(cfg, { ctx, event: `sidePanel.open rejected: ${error}` }),
  )
})
document.getElementById('close-panel')?.addEventListener('click', () => {
  chrome.sidePanel.close({ windowId }).then(
    () => report(cfg, { ctx, event: 'sidePanel.close resolved' }),
    (error) => report(cfg, { ctx, event: `sidePanel.close rejected: ${error}` }),
  )
})
document.getElementById('sw-probe')?.addEventListener('click', async () => {
  out.textContent = JSON.stringify(await chrome.runtime.sendMessage({ type: 'probe' }), null, 2)
})
document.getElementById('sw-hold')?.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'hold' })
})
// どの directory の host manifest を読むかを見るため、directory ごとに名前を変えた host を並べて呼べる。
document.getElementById('native')?.addEventListener('click', async () => {
  const results = {}
  for (const name of (cfg.native ?? 'com.monica.probe').split(',')) {
    try {
      const { argv, cwd } = await chrome.runtime.sendNativeMessage(name, { from: ctx })
      results[name] = { argv, cwd }
    } catch (error) {
      results[name] = { error: String(error) }
    }
  }
  out.textContent = JSON.stringify(results, null, 2)
  await report(cfg, { ctx, native: results })
})

const results = await runProbes(ctx, cfg)
out.textContent = JSON.stringify(results, null, 2)
if (cfg.hold !== '0') holdStreams(ctx, cfg)
