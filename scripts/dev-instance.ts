import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const DEFAULT_HOME = join(homedir(), '.tania-dev')
export const RELEASE_HOME = join(homedir(), '.tania')

const IDENTIFIER = 'com.ashigirl96.tania.dev'
const DEFAULT_PORT = 1420
// release の notes の口は 19380（ADR-0017）。
const DEFAULT_NOTES_PORT = 19381
// notes の口を散らす範囲（19382〜19481）の外に置く。
const DEFAULT_WEB_PORT = 19581
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

type DevInstance = {
  identifier: string
  preferredPort: number
  notesPort: number
  webPort: number
}

// 同じ home を別の書き方で渡しても single-instance をすり抜けないよう、realpath を key にする。
export function devInstance(home: string): DevInstance {
  const key = canonical(home)
  if (key === canonical(DEFAULT_HOME)) {
    return {
      identifier: IDENTIFIER,
      preferredPort: DEFAULT_PORT,
      notesPort: DEFAULT_NOTES_PORT,
      webPort: DEFAULT_WEB_PORT,
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
    notesPort: DEFAULT_NOTES_PORT + offset,
    webPort: DEFAULT_WEB_PORT + offset,
  }
}
