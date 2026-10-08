import { realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { type Cdp, attach, browserEndpoint, connectCdp, evaluate } from './cdp'
import { DEFAULT_HOME, braveProfile, extensionDevOutput } from './dev-instance'

const SIDE_PANEL_PAGE = 'src/sidepanel/index.html'

type TargetInfo = { targetId: string; type: string; url: string }

async function devExtensionId(cdp: Cdp, devOutput: string): Promise<string> {
  const { extensions } = await cdp.send<{ extensions: { id: string; path: string }[] }>(
    'Extensions.getExtensions',
  )
  const target = realpathSync(devOutput)
  const dev = extensions.find(({ path }) => {
    try {
      return realpathSync(path) === target
    } catch {
      return false
    }
  })
  if (!dev) throw new Error(`${devOutput} から読み込んだ Chrome Extension がありません`)
  return dev.id
}

async function targets(cdp: Cdp, type: string): Promise<TargetInfo[]> {
  const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets', {
    filter: [{ type }],
  })
  return targetInfos
}

// 開いた直後の page は、URL が決まっても chrome.tabs がまだ無く、読み込みの途中で context が入れ替わる。
async function inBrowserTab(cdp: Cdp, targetId: string): Promise<boolean> {
  const sessionId = await attach(cdp, targetId)
  try {
    for (let i = 0; i < 50; i++) {
      const answer = await evaluate(
        cdp,
        sessionId,
        "globalThis.chrome?.tabs ? chrome.tabs.getCurrent().then(Boolean) : 'loading'",
      ).catch(() => 'loading')
      if (answer !== 'loading') return answer === true
      await Bun.sleep(100)
    }
    throw new Error(`${targetId} の page が読み込まれない`)
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId })
  }
}

// Browser Tab で開いた同じ page とは、chrome.tabs.getCurrent() が tab を返さないことで見分ける。
async function sidePanel(cdp: Cdp, id: string): Promise<string | undefined> {
  const url = `chrome-extension://${id}/${SIDE_PANEL_PAGE}`
  for (const { targetId } of (await targets(cdp, 'page')).filter((t) => t.url.startsWith(url))) {
    if (!(await inBrowserTab(cdp, targetId))) return targetId
  }
  return undefined
}

async function openSidePanel(cdp: Cdp, id: string): Promise<string> {
  // action は開閉を切り替えるので、開いていれば押さない。
  const open = await sidePanel(cdp, id)
  if (open) return open
  const [tab] = await targets(cdp, 'tab')
  if (!tab) throw new Error('side panel を開く Browser Tab がありません')
  await cdp.send('Extensions.triggerAction', { id, targetId: tab.targetId })
  for (let i = 0; i < 100; i++) {
    const opened = await sidePanel(cdp, id)
    if (opened) return opened
    await Bun.sleep(100)
  }
  throw new Error('action を押しても side panel が開かなかった')
}

async function openedSidePanel(cdp: Cdp, id: string): Promise<string> {
  const panel = await sidePanel(cdp, id)
  if (!panel) throw new Error('side panel が開いていません。先に open を打ってください')
  return attach(cdp, panel)
}

// open と同じく最初の Browser Tab で action を押すので、window が 1 つの Brave で使う。
async function closeSidePanel(cdp: Cdp, id: string): Promise<void> {
  const panel = await sidePanel(cdp, id)
  if (!panel) throw new Error('side panel が開いていません')
  const [tab] = await targets(cdp, 'tab')
  if (!tab) throw new Error('action を押す Browser Tab がありません')
  await cdp.send('Extensions.triggerAction', { id, targetId: tab.targetId })
  for (let i = 0; i < 100; i++) {
    const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets')
    if (!targetInfos.some(({ targetId }) => targetId === panel)) return
    await Bun.sleep(50)
  }
  throw new Error('action を押しても side panel が閉じなかった')
}

// side panel が閉じるか、SIGINT・SIGTERM を受けるまで、URL に path を含む request の body を 1 行ずつ出す。
async function printRequests(cdp: Cdp, id: string, path: string): Promise<void> {
  const sessionId = await openedSidePanel(cdp, id)
  const { promise: ended, resolve: end } = Promise.withResolvers<void>()
  process.on('SIGINT', end)
  process.on('SIGTERM', end)
  cdp.on('Target.detachedFromTarget', (params) => {
    if ((params as { sessionId: string }).sessionId === sessionId) end()
  })
  cdp.on('Network.requestWillBeSent', (params, from) => {
    const { requestId, request } = params as {
      requestId: string
      request: { url: string; method: string; postData?: string; hasPostData?: boolean }
    }
    if (from !== sessionId || !request.url.includes(path)) return
    void (async () => {
      const body =
        request.postData ??
        (request.hasPostData
          ? (
              await cdp.send<{ postData: string }>(
                'Network.getRequestPostData',
                { requestId },
                sessionId,
              )
            ).postData
          : undefined)
      console.log(JSON.stringify({ url: request.url, method: request.method, body }))
    })()
  })
  await cdp.send('Network.enable', {}, sessionId)
  console.error(`[extension-panel] ${path} への request を待っています`)
  await ended
}

const usage = `使い方: MONICA_HOME=<home> bun scripts/extension-panel.ts open | close | eval '<js>' | screenshot <path> | requests <path>`
const [command, arg] = process.argv.slice(2)
const home = resolve(process.env.MONICA_HOME || DEFAULT_HOME)
const endpoint = browserEndpoint(braveProfile(home))
if (!endpoint) {
  console.error(
    `${home} の Brave に CDP の port がありません（bun run extension --headless で起こす）`,
  )
  process.exit(1)
}
const cdp = await connectCdp(endpoint)
try {
  const id = await devExtensionId(cdp, extensionDevOutput(home))
  if (command === 'open') {
    console.log(await openSidePanel(cdp, id))
  } else if (command === 'close') {
    await closeSidePanel(cdp, id)
  } else if (command === 'requests' && arg) {
    await printRequests(cdp, id, arg)
  } else if (command === 'eval' && arg) {
    const sessionId = await openedSidePanel(cdp, id)
    console.log(JSON.stringify(await evaluate(cdp, sessionId, arg, { userGesture: true })))
  } else if (command === 'screenshot' && arg) {
    const sessionId = await openedSidePanel(cdp, id)
    const { data } = await cdp.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png' },
      sessionId,
    )
    writeFileSync(arg, Buffer.from(data, 'base64'))
    console.log(resolve(arg))
  } else {
    console.error(usage)
    process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  cdp.close()
}
