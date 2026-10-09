import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { DEFAULT_HOME } from './dev-instance'

// Chrome Extension が build の時に焼く Native Messaging の host 名。release は apps/desktop/src-tauri/src/native_host.rs の NAME と揃える。
export const RELEASE_NATIVE_HOST = 'com.ashigirl96.monica'
export const DEV_NATIVE_HOST = 'com.ashigirl96.monica_dev'

const DEV_EXTENSION_ORIGIN = 'chrome-extension://jhcphbonbcemkjkhofopmhbfphenihoj/'

// Brave は user-data-dir に依らず、Google Chrome の場所の manifest だけを読む（ADR-0034）。
const NATIVE_MESSAGING_HOSTS = join(
  homedir(),
  'Library/Application Support/Google/Chrome/NativeMessagingHosts',
)

// どの worktree が書いても同じ中身になるよう、worktree の外の決まった場所に置く。
const DEV_NATIVE_HOST_PATH = join(DEFAULT_HOME, 'native-host')

// manifest の path は引数を持てないので、どの worktree の CLI で答えるかは dev の Brave から継いだ env で決める。
const DEV_HOST_SCRIPT = `#!/bin/sh
exec "\${MONICA_REPO:?is not set; start Brave with bun run extension}/scripts/monica-dev" "$@"
`

/** dev の host manifest と、それが指す実行 file を書く。中身が同じなら書かない。 */
export function writeDevNativeHost({
  manifestDir = NATIVE_MESSAGING_HOSTS,
  hostPath = DEV_NATIVE_HOST_PATH,
}: { manifestDir?: string; hostPath?: string } = {}): void {
  writeIfChanged(hostPath, DEV_HOST_SCRIPT, 0o755)
  const manifest = {
    name: DEV_NATIVE_HOST,
    description:
      'Hands the Monica (dev) Chrome Extension the port and the chat token of the Backend',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [DEV_EXTENSION_ORIGIN],
  }
  writeIfChanged(
    join(manifestDir, `${DEV_NATIVE_HOST}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o644,
  )
}

function writeIfChanged(path: string, content: string, mode: number): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const staged = `${path}.${process.pid}.tmp`
  writeFileSync(staged, content)
  chmodSync(staged, mode)
  renameSync(staged, path)
}
