import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 共有の tmpdir には他の run の残りも混ざるので、この run の残りだけを見るために空の TMPDIR を渡す。
// ptyd の socket の path は 104 byte が上限なので、名前は短くする。
const dir = mkdtempSync(join(tmpdir(), 'monica-t-'))
const test = Bun.spawn([process.execPath, 'test', '--pass-with-no-tests'], {
  env: { ...process.env, TMPDIR: dir },
  stdout: 'inherit',
  stderr: 'inherit',
})
const code = await test.exited

const leftovers = readdirSync(dir).map((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? `${name}/ (${readdirSync(path).join(' ')})` : name
})
rmSync(dir, { recursive: true, force: true })
for (const leftover of leftovers) console.error(`bun test が TMPDIR に残した: ${leftover}`)

process.exit(code !== 0 ? code : leftovers.length > 0 ? 1 : 0)
