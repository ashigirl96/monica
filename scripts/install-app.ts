import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { $ } from 'bun'

const built = join(import.meta.dir, '../target/release/bundle/macos/tania.app')
const installed = '/Applications/tania.app'

if (!existsSync(built)) {
  console.error(`${built} がありません。先に bun run build を流してください`)
  process.exit(1)
}
rmSync(installed, { recursive: true, force: true })
await $`cp -R ${built} ${installed}`
// Keychain Access で作った自己署名の identity。ad-hoc と違い、build をまたいで署名の同一性が保たれる。
await $`codesign --force --sign tania ${installed}`
await $`xattr -dr com.apple.quarantine ${installed}`.nothrow().quiet()
console.log(`Installed: ${installed}`)
