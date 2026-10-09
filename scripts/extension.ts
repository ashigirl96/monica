import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { Subprocess } from 'bun'

import { attach, browserEndpoint, connectCdp, evaluate } from './cdp'
import {
  BRAVE,
  DEFAULT_HOME,
  RELEASE_HOME,
  braveProfile,
  extensionDevOutput,
  isReleaseHome,
} from './dev-instance'

const extensionDir = join(import.meta.dir, '../apps/extension')
const headless = process.argv.includes('--headless')

const home = resolve(process.env.MONICA_HOME || DEFAULT_HOME)
// release の Tab は MONICA_HOME=~/.monica を継ぐので、そこで起こすと release の home に dev の profile を作る。
if (isReleaseHome(home)) {
  console.error(
    `MONICA_HOME が release の home（${RELEASE_HOME}）です。dev の home を渡してください（例: MONICA_HOME=~/.monica-dev bun run extension）`,
  )
  process.exit(1)
}
if (!existsSync(BRAVE)) {
  console.error(`Brave が ${BRAVE} にありません`)
  process.exit(1)
}
process.env.MONICA_HOME = home
mkdirSync(home, { recursive: true, mode: 0o700 })
const profile = braveProfile(home)
const devOutput = extensionDevOutput(home)

const children = new Set<Subprocess>()
let stopping = false

async function stopAll(code: number): Promise<never> {
  if (!stopping) {
    stopping = true
    for (const child of children) child.kill('SIGTERM')
    await Promise.all([...children].map((child) => child.exited))
    process.exit(code)
  }
  return new Promise<never>(() => {})
}

process.on('SIGINT', () => void stopAll(130))
process.on('SIGTERM', () => void stopAll(143))

// 片方が終われば、もう片方も止めて抜ける。
// Bun.spawn の既定の env は起動時の env で、上で書き換えた MONICA_HOME（resolve した home）を含まない。
function supervise(argv: string[], options: { cwd?: string } = {}): Subprocess {
  const child = Bun.spawn(argv, {
    ...options,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  children.add(child)
  void child.exited.then((code) => stopAll(code))
  return child
}

async function until(ready: () => boolean, child: Subprocess, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (ready()) return
    if (child.exitCode !== null) await stopAll(1)
    await Bun.sleep(100)
  }
  console.error(`[extension] ${what}を待ちきれなかった`)
  await stopAll(1)
}

// Chromium は終了時に DevToolsActivePort を消さないので、古い port を読まないよう起こす前に消す。
function forgetDevToolsPort(): void {
  rmSync(join(profile, 'DevToolsActivePort'), { force: true })
}

function braveArgs(...extra: string[]): string[] {
  return [
    BRAVE,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...extra,
  ]
}

function developerModeOn(): boolean {
  try {
    const prefs = JSON.parse(readFileSync(join(profile, 'Default/Secure Preferences'), 'utf8')) as {
      extensions?: { ui?: { developer_mode?: boolean } }
    }
    return prefs.extensions?.ui?.developer_mode === true
  } catch {
    return false
  }
}

// 開発者モードが off の profile では、CRXJS の reload の後に unpacked の Chrome Extension が無効になる。
// Default/Preferences に書いても Brave は Secure Preferences の MAC で既定に戻すので、Brave 自身に書かせる（ADR-0029）。
async function enableDeveloperMode(): Promise<void> {
  if (developerModeOn()) return
  forgetDevToolsPort()
  const brave = Bun.spawn(braveArgs('--headless=new', '--remote-debugging-port=0'), {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  children.add(brave)
  await until(
    () => browserEndpoint(profile) !== undefined,
    brave,
    '開発者モードを書く Brave の起動',
  )
  const cdp = await connectCdp(browserEndpoint(profile)!)
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
    url: 'brave://extensions',
  })
  const sessionId = await attach(cdp, targetId)
  for (let i = 0; ; i++) {
    const loaded = await evaluate(
      cdp,
      sessionId,
      "typeof globalThis.chrome?.developerPrivate?.updateProfileConfiguration === 'function'",
    ).catch(() => false)
    if (loaded) break
    if (i === 100) throw new Error('brave://extensions に developerPrivate が出てこない')
    await Bun.sleep(100)
  }
  await evaluate(
    cdp,
    sessionId,
    'chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })',
  )
  // 開いたままだと、次に起こす Brave が session を戻して brave://extensions の Browser Tab を出す。
  await cdp.send('Target.closeTarget', { targetId })
  await cdp.send('Browser.close').catch(() => {})
  cdp.close()
  await brave.exited
  children.delete(brave)
}

async function start(): Promise<void> {
  await enableDeveloperMode()

  // 前の dev の出力が残っていると、書き直される前の古い loader を Brave に読み込ませる。
  rmSync(devOutput, { recursive: true, force: true })
  const vite = supervise([join(extensionDir, 'node_modules/.bin/vite')], { cwd: extensionDir })
  await until(() => existsSync(join(devOutput, 'manifest.json')), vite, 'dev の出力')

  forgetDevToolsPort()
  const brave = supervise(
    braveArgs(
      `--load-extension=${devOutput}`,
      ...(headless ? ['--headless=new', '--remote-debugging-port=0'] : []),
    ),
  )
  if (headless) await until(() => browserEndpoint(profile) !== undefined, brave, 'Brave の CDP')
  console.log('[extension] ready')
}

try {
  await start()
} catch (error) {
  console.error(`[extension] ${error instanceof Error ? error.message : String(error)}`)
  await stopAll(1)
}
