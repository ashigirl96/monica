import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 1 本ごとに sh と bun の process を起こし、doctor.sh --wait は 2 秒待つ。
setDefaultTimeout(30_000)

const scripts = join(import.meta.dir, '..', '.claude', 'skills', 'verify-monica', 'scripts')
const sandboxes: string[] = []

afterAll(() => {
  for (const dir of sandboxes) {
    // 打ち切った sh の孫の sleep は init の子になって残るので、pid の file から止める。
    // shortcut: 同じ name で 2 回起こすテストの 1 回目の sleep は pid の file が上書きされて辿れず、sleep を止めない退行で落ちた run にだけ残る。残りが問題になったら、起こすごとに pid を別の file に控える。
    // 止まった sleep の pid は別の process に使い回されうるので、command 行で確かめる。
    for (const pidFile of new Bun.Glob('t/verify-monica/*/stdin.pid').scanSync(dir)) {
      const pid = Number(readFileSync(join(dir, pidFile), 'utf8'))
      const command = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)])
        .stdout.toString()
        .trim()
      if (command === 'sleep 2147483647') process.kill(pid)
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

// HOME と TMPDIR を一時 dir に向け、本物の ~/.claude/projects と他の instance に触れない。
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'vm-'))
  sandboxes.push(root)
  const home = join(root, 'h')
  const tmp = join(root, 't')
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  mkdirSync(tmp)
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    // spawnSync はテストの timeout でも止まらないので、pipeline が終わらない退行で run ごと止まらないよう打ち切る。
    const proc = Bun.spawnSync(['sh', join(scripts, script), ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        USER: 'verify',
        LANG: 'C',
        HOME: home,
        TMPDIR: `${tmp}/`,
        ...env,
      },
      timeout: 20_000,
    })
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString() }
  }
  const project = (name: string) => {
    const dir = join(home, '.claude', 'projects', name)
    mkdirSync(dir)
    writeFileSync(join(dir, 's.jsonl'), '{"type":"user"}\n')
    return dir
  }
  return { tmp, run, project }
}

const exitingBackend = { VERIFY_BACKEND: '/usr/bin/false' }

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('launch reports a Backend that exits, stops its stdin sleep, and doctor gives up early', () => {
  const { tmp, run } = sandbox()

  expect(run('launch.sh', ['c1'], exitingBackend).exitCode).toBe(1)

  const evidence = join(tmp, 'verify-monica', 'c1')
  expect(readFileSync(join(evidence, 'err.log'), 'utf8').trim().split('\n').at(-1)).toBe(
    '[launch exited]',
  )
  expect(alive(Number(readFileSync(join(evidence, 'stdin.pid'), 'utf8')))).toBe(false)
  const started = Date.now()
  expect(run('doctor.sh', ['c1', '--wait']).exitCode).toBe(1)
  expect(Date.now() - started).toBeLessThan(10_000)
})

test('a relaunch under the same name is not failed by the previous run’s exit marker', () => {
  const { tmp, run } = sandbox()
  run('launch.sh', ['c2'], exitingBackend)

  run('launch.sh', ['c2'], { VERIFY_BACKEND: '/usr/bin/true' })

  expect(readFileSync(join(tmp, 'verify-monica', 'c2', 'err.log'), 'utf8')).toBe(
    '[launch exited]\n',
  )
})

test('launch refuses an argument that is not VAR=value before it makes the home', () => {
  const { tmp, run } = sandbox()

  expect(run('launch.sh', ['c3', 'not-an-assignment'], exitingBackend).exitCode).toBe(1)

  expect(existsSync(join(tmp, 'monica-c3'))).toBe(false)
})

test('cleanup keeps every claude transcript dir and lists only those that appeared after launch', () => {
  const { tmp, run, project } = sandbox()
  const before = project('-private-var-T-monica-c4-old')
  run('launch.sh', ['c4'], exitingBackend)
  const mine = project('-private-var-T-monica-c4-own')
  const another = project('-private-var-T-monica-c4-foo-bar')

  const { exitCode, stdout } = run('cleanup.sh', ['c4'])

  expect(exitCode).toBe(0)
  for (const dir of [before, mine, another]) expect(existsSync(join(dir, 's.jsonl'))).toBe(true)
  expect(stdout).toContain(mine)
  expect(stdout).toContain(another)
  expect(stdout).not.toContain(before)
  expect(existsSync(join(tmp, 'monica-c4'))).toBe(false)
  expect(existsSync(join(tmp, 'verify-monica', 'c4', 'err.log'))).toBe(true)
})

test('cleanup removes the Bench scratch dirs but keeps one that is another instance’s home', () => {
  const { tmp, run } = sandbox()
  run('launch.sh', ['c5'], exitingBackend)
  mkdirSync(join(tmp, 'monica-c5-ghq', 'github.com', 'a', 'b'), { recursive: true })
  mkdirSync(join(tmp, 'monica-c5-origin'))
  writeFileSync(join(tmp, 'monica-c5-origin', 'monica.db'), '')

  expect(run('cleanup.sh', ['c5']).exitCode).toBe(0)

  expect(existsSync(join(tmp, 'monica-c5-ghq'))).toBe(false)
  expect(existsSync(join(tmp, 'monica-c5-origin', 'monica.db'))).toBe(true)
})
