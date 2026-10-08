import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 検査の出力はテストの Ledger が stderr に書く行で長くなる。パイプで絞ると終了コードがパイプの末尾のものになるので、絞るのはここで行い、検査の終了コードで抜ける。
const script = process.argv[2] ?? 'check'
const log = join(tmpdir(), `monica-${script.replace(':', '-')}-${process.pid}.log`)
const run = Bun.spawn(['sh', '-c', 'exec bun run "$0" > "$1" 2>&1', script, log], {
  env: process.env,
  stdout: 'inherit',
  stderr: 'inherit',
})
const code = await run.exited
const lines = (await Bun.file(log).text()).split('\n')

const noise = /^\[(workbench|task|job|note|backend|shell)\] |^\(pass\) |^\s*$/
const summary = /^Ran \d+ tests|^ *\d+ (pass|fail)$/

if (code === 0) {
  for (const line of lines.filter((l) => summary.test(l))) console.log(line)
  console.log(`${script} passed (full log: ${log})`)
} else {
  for (const line of lines.filter((l) => !noise.test(l)).slice(-200)) console.log(line)
  console.log(`${script} failed with exit code ${code} (full log: ${log})`)
}
process.exit(code)
