import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const DEFAULT_HOME = join(homedir(), '.monica-dev')
export const RELEASE_HOME = join(homedir(), '.monica')

const IDENTIFIER = 'com.ashigirl96.monica.dev'
const DEFAULT_PORT = 1420
// release のブラウザの口は 19380（ADR-0017）。
const DEFAULT_BROWSER_PORT = 19381
// ブラウザの口を散らす範囲（19382〜19481）の外に置く。
const DEFAULT_WEB_PORT = 19581
// apps/web の Vite の port を散らす範囲（19582〜19681）の外に置く。
const DEFAULT_EXTENSION_PORT = 19781
const PORT_SPREAD = 100

// まだ作られていない既定の home は、書かれたとおりの path で比べる。
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function isReleaseHome(home: string): boolean {
  return canonical(home) === canonical(RELEASE_HOME)
}

export const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'

// bun run extension が dev の Chrome Extension を読み込ませる Brave の user-data-dir。
export function braveProfile(home: string): string {
  return join(home, 'dev-brave')
}

// dev の出力は Vite の port を焼き込むので、同じ checkout の別の home と分ける。
export function extensionDevOutput(home: string): string {
  return join(home, 'dev-extension')
}

type DevInstance = {
  identifier: string
  preferredPort: number
  browserPort: number
  webPort: number
  extensionPort: number
}

// 同じ home を別の書き方で渡しても single-instance をすり抜けないよう、realpath を key にする。
export function devInstance(home: string): DevInstance {
  const key = canonical(home)
  if (key === canonical(DEFAULT_HOME)) {
    return {
      identifier: IDENTIFIER,
      preferredPort: DEFAULT_PORT,
      browserPort: DEFAULT_BROWSER_PORT,
      webPort: DEFAULT_WEB_PORT,
      extensionPort: DEFAULT_EXTENSION_PORT,
    }
  }
  const hash = createHash('sha256').update(key).digest()
  const slug = basename(key)
    .replace(/^\./, '')
    .replace(/[^A-Za-z0-9-]/g, '-')
  const offset = 1 + (hash.readUInt32BE(0) % PORT_SPREAD)
  return {
    identifier: `${IDENTIFIER}.${slug}-${hash.toString('hex').slice(0, 6)}`,
    preferredPort: DEFAULT_PORT + offset,
    browserPort: DEFAULT_BROWSER_PORT + offset,
    webPort: DEFAULT_WEB_PORT + offset,
    extensionPort: DEFAULT_EXTENSION_PORT + offset,
  }
}
