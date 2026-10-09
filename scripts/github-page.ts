import { resolve } from 'node:path'

import { attach, connectCdp, evaluate } from './cdp'

type TargetInfo = { targetId: string; type: string; url: string }

const CONTENT_SCRIPT = resolve(import.meta.dir, '../apps/extension/src/issues-page.ts')

// service worker と Backend の代わりに、どの ref にもボタンを出さず reason を返す。
function fakeRuntime(reason: string): string {
  return `globalThis.chrome = { runtime: { sendMessage: async (request) => ({ buttons: request.refs.map((ref) => ({ ref, button: null, reason: ${JSON.stringify(reason)}.replaceAll('{ref}', ref) })) }) } };`
}

async function bundledContentScript(): Promise<string> {
  const built = await Bun.build({ entrypoints: [CONTENT_SCRIPT], format: 'iife' })
  if (!built.success) throw new Error(built.logs.map(String).join('\n'))
  const [output] = built.outputs
  if (!output) throw new Error(`${CONTENT_SCRIPT} の bundle が空です`)
  return output.text()
}

const usage = `使い方: bun scripts/github-page.ts <agent-browser get cdp-url の ws URL> inject '<reason。{ref} は Issue の ref>' | script <js の file>`
const [endpoint, command, arg] = process.argv.slice(2)
if (!endpoint || !arg || (command !== 'inject' && command !== 'script')) {
  console.error(usage)
  process.exit(1)
}
const cdp = await connectCdp(endpoint)
try {
  const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets', {
    filter: [{ type: 'page' }],
  })
  const page = targetInfos.find(({ url }) => new URL(url).host === 'github.com')
  if (!page) throw new Error('github.com を開いた page がありません')
  const sessionId = await attach(cdp, page.targetId)
  if (command === 'inject') {
    await evaluate(cdp, sessionId, fakeRuntime(arg) + (await bundledContentScript()))
    // content script は 150ms の debounce の後に走査し、偽の sendMessage の答えでボタンを差し込む。
    await Bun.sleep(500)
    const count = await evaluate(
      cdp,
      sessionId,
      "document.querySelectorAll('[data-monica-run-button]').length",
    )
    console.log(`${count} 個の Run を差し込みました`)
  } else {
    console.log(JSON.stringify(await evaluate(cdp, sessionId, await Bun.file(arg).text())))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  cdp.close()
}
