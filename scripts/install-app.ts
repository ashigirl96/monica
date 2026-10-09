import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { $ } from 'bun'

import { bundledClaude } from './bundled-claude.ts'

const repo = join(import.meta.dir, '..')
const built = join(repo, 'target/release/bundle/macos/Monica.app')
const extension = join(repo, 'apps/extension/dist/production')
const installed = '/Applications/Monica.app'
const desktop = join(installed, 'Contents/MacOS/monica-desktop')
const backendJson = join(homedir(), '.monica/backend.json')

const { values } = parseArgs({ options: { stage: { type: 'string' } } })

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function running(): Promise<boolean> {
  return (await $`pgrep -f ${`^${desktop}`}`.nothrow().quiet()).exitCode === 0
}

type Backend = { port: number; token: string; pid: number }

async function backend(): Promise<Backend | null> {
  try {
    return await Bun.file(backendJson).json()
  } catch {
    return null
  }
}

async function healthy({ port }: Backend, timeoutMs: number): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(timeoutMs)
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal })).ok
  } catch {
    return false
  }
}

// bundle だけを入れ替えると、手元の変更より古い build が黙って入るので、毎回 build してから入れる。
await $`bun ${join(import.meta.dir, 'build.ts')}`

// 足りないまま入れ替えると Monica を起こせなくなるので、Monica を終了させる前に検める。
if (!existsSync(built)) fail(`${built} がありません。build が .app を作りませんでした`)
if (!existsSync(join(extension, 'manifest.json'))) {
  fail(`${extension}/manifest.json がありません。build が Chrome Extension を作りませんでした`)
}
let claude: string
try {
  claude = bundledClaude()
} catch (error) {
  // require の error は 2 行目から Require stack を並べる。
  const [reason] = (error as Error).message.split('\n')
  fail(`同梱する claude を packages/chat の依存から解けません: ${reason}`)
}

// 署名する前の .app を開けないよう、一時の場所で写しと署名を済ませてから置く。
// claude の写しの分だけ Monica が止まる時間を延ばさないよう、Monica を終了させる前に済ませる。
const stagingDir = values.stage
  ? resolve(values.stage)
  : mkdtempSync(join(tmpdir(), 'monica-install-'))
const staging = join(stagingDir, 'Monica.app')
mkdirSync(stagingDir, { recursive: true })
rmSync(staging, { recursive: true, force: true })
await $`cp -R ${built} ${staging}`
await $`cp ${claude} ${join(staging, 'Contents/MacOS/claude')}`
await $`cp -R ${extension} ${join(staging, 'Contents/Resources/extension')}`
// Keychain Access で作った自己署名の identity。ad-hoc と違い、build をまたいで署名の同一性が保たれる。
// --deep を付けると claude の Anthropic の署名が Monica のものに置き換わる（ADR-0032）。
await $`codesign --force --sign Monica ${staging}`
await $`xattr -dr com.apple.quarantine ${staging}`.nothrow().quiet()

if (values.stage) {
  console.log(`Staged: ${staging}`)
  process.exit(0)
}

// pid は再利用されうるので、起動のたびに変わる token で新しい Backend を見分ける。
const before = (await backend())?.token

// 起きている Monica は入れ替えの途中の .app を読むので、先に終了させる。Tab の shell と claude は ptyd が持ち続ける。
if (await running()) {
  await $`osascript -e 'tell application id "com.ashigirl96.monica" to quit'`.nothrow().quiet()
  for (let i = 0; i < 100 && (await running()); i++) await Bun.sleep(100)
  if (await running()) {
    rmSync(stagingDir, { recursive: true, force: true })
    fail('Monica が終了しません。⌘Q で終了してから流してください')
  }
}

rmSync(installed, { recursive: true, force: true })
await $`mv ${staging} ${installed}`
rmSync(stagingDir, { recursive: true, force: true })
console.log(`Installed: ${installed}`)

await $`open ${installed}`
const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  const started = await backend()
  if (
    started &&
    started.token !== before &&
    (await healthy(started, Math.max(1, deadline - Date.now())))
  ) {
    console.log(`Started: Backend pid ${started.pid}`)
    process.exit(0)
  }
  await Bun.sleep(100)
}
fail(`Monica を起こしましたが、30 秒待っても ${backendJson} の Backend が答えません`)
