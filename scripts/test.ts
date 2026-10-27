import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

// 共有の tmpdir には他の run の残りも混ざるので、この run の残りだけを見るために空の TMPDIR を渡す。
// ptyd の socket の path は 104 byte が上限なので、名前は短くする。
const dir = mkdtempSync(join(tmpdir(), 'monica-t-'))
// dir の外に置くと、run が落ちたときに `dev:list` が拾う `monica-*` として残る。
const progress = join(dir, '.test-progress')
const stallMs = Number(process.env.MONICA_TEST_STALL_MS ?? 120_000)
// bunfig.toml の [test] は parallel を黙って無視するので、引数で渡す。
// timings の file は check では読むだけにし、書き換えるのは `bun run test:timings` が渡す `--update-timings` のときだけにする。
const timings = join(import.meta.dir, 'test-timings.json')
const test = Bun.spawn(
  [
    process.execPath,
    'test',
    '--pass-with-no-tests',
    '--parallel=8',
    // mods/ の test は claude-code/testing を import し、`claude plugin test` でしか走らない。
    '--path-ignore-patterns=mods/**',
    `--timings=${timings}`,
    `--preload=${join(import.meta.dir, 'test-progress.ts')}`,
    ...process.argv.slice(2),
  ],
  {
    // CI の git には利用者の設定が無く、identity も推測できずに commit が落ちるので、手元でも同じ失敗を出す。
    env: {
      ...process.env,
      TMPDIR: dir,
      MONICA_TEST_PROGRESS: progress,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.useConfigOnly',
      GIT_CONFIG_VALUE_0: 'true',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  },
)

const progressSize = () => statSync(progress, { throwIfNoEntry: false })?.size ?? 0

const unfinishedFiles = () => {
  const started = new Set<string>()
  const text = existsSync(progress) ? readFileSync(progress, 'utf8') : ''
  for (const [, event, path = ''] of text.matchAll(/^(\w+) (.+)$/gm)) {
    if (event === 'start') started.add(path)
    if (event === 'end') started.delete(path)
  }
  return [...started]
}

const children = (pid: number) =>
  Bun.spawnSync(['pgrep', '-P', String(pid)])
    .stdout.toString()
    .split('\n')
    .filter(Boolean)
    .map(Number)

const kill = (pid: number) => {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

let lastSize = 0
let lastChange = Date.now()
const watchdog = setInterval(
  () => {
    const size = progressSize()
    if (size !== lastSize) {
      lastSize = size
      lastChange = Date.now()
      return
    }
    if (Date.now() - lastChange < stallMs) return
    clearInterval(watchdog)
    console.error(
      `bun test の進捗が ${stallMs / 1000} 秒止まったので kill する。終わっていない test file:`,
    )
    for (const path of unfinishedFiles()) console.error(`  ${relative(process.cwd(), path)}`)
    // worker は本体と別の process group に入り、本体だけを kill すると孤児になって CPU を握ったまま残るので、子を先に kill する。
    for (const pid of children(test.pid)) kill(pid)
    kill(test.pid)
  },
  Math.min(1000, stallMs / 4),
)
const code = await test.exited
clearInterval(watchdog)

rmSync(progress, { force: true })
const leftovers = readdirSync(dir).map((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? `${name}/ (${readdirSync(path).join(' ')})` : name
})
rmSync(dir, { recursive: true, force: true })
for (const leftover of leftovers) console.error(`bun test が TMPDIR に残した: ${leftover}`)

process.exit(code !== 0 ? code : leftovers.length > 0 ? 1 : 0)
