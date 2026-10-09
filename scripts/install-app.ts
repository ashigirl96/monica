import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { $ } from 'bun'

const built = join(import.meta.dir, '../target/release/bundle/macos/Monica.app')
const installed = '/Applications/Monica.app'
const desktop = join(installed, 'Contents/MacOS/monica-desktop')
const backendJson = join(homedir(), '.monica/backend.json')

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

// pid は再利用されうるので、起動のたびに変わる token で新しい Backend を見分ける。
const before = (await backend())?.token

// 起きている Monica は入れ替えの途中の .app を読むので、先に終了させる。Tab の shell と claude は ptyd が持ち続ける。
if (await running()) {
  await $`osascript -e 'tell application id "com.ashigirl96.monica" to quit'`.nothrow().quiet()
  for (let i = 0; i < 100 && (await running()); i++) await Bun.sleep(100)
  if (await running()) {
    console.error('Monica が終了しません。⌘Q で終了してから流してください')
    process.exit(1)
  }
}

// 署名する前の .app を開けないよう、一時の場所で署名してから置く。
const stagingDir = mkdtempSync(join(tmpdir(), 'monica-install-'))
const staging = join(stagingDir, 'Monica.app')
await $`cp -R ${built} ${staging}`
// Keychain Access で作った自己署名の identity。ad-hoc と違い、build をまたいで署名の同一性が保たれる。
await $`codesign --force --sign Monica ${staging}`
await $`xattr -dr com.apple.quarantine ${staging}`.nothrow().quiet()
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
console.error(`Monica を起こしましたが、30 秒待っても ${backendJson} の Backend が答えません`)
process.exit(1)
