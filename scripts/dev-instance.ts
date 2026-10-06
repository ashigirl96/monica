import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const DEFAULT_HOME = join(homedir(), '.tania-dev')
export const RELEASE_HOME = join(homedir(), '.tania')

const IDENTIFIER = 'com.ashigirl96.tania.dev'
const DEFAULT_PORT = 1420
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

// 同じ home を別の書き方で渡しても single-instance をすり抜けないよう、realpath を key にする。
export function devInstance(home: string): { identifier: string; preferredPort: number } {
  const key = canonical(home)
  if (key === canonical(DEFAULT_HOME))
    return { identifier: IDENTIFIER, preferredPort: DEFAULT_PORT }
  const hash = createHash('sha256').update(key).digest()
  const slug = basename(key)
    .replace(/^\./, '')
    .replace(/[^A-Za-z0-9-]/g, '-')
  return {
    identifier: `${IDENTIFIER}.${slug}-${hash.toString('hex').slice(0, 6)}`,
    preferredPort: DEFAULT_PORT + 1 + (hash.readUInt32BE(0) % PORT_SPREAD),
  }
}
