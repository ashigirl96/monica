import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { $ } from 'bun'

import { bundledClaude } from './bundled-claude.ts'

const repo = join(import.meta.dir, '..')
const built = join(repo, 'target/release/bundle/macos/Monica.app')
const extension = join(repo, 'apps/extension/dist/production')
const installed = '/Applications/Monica.app'
const desktop = join(installed, 'Contents/MacOS/monica-desktop')

const { values } = parseArgs({ options: { stage: { type: 'string' } } })

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

// 足りないまま入れ替えると Monica を起こせなくなるので、Monica を終了させる前に検める。
if (!existsSync(built)) fail(`${built} がありません。先に bun run build を流してください`)
if (!existsSync(join(extension, 'manifest.json'))) {
  fail(`${extension}/manifest.json がありません。先に bun run build を流してください`)
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

async function running(): Promise<boolean> {
  return (await $`pgrep -f ${`^${desktop}`}`.nothrow().quiet()).exitCode === 0
}

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
