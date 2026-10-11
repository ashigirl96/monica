import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

setDefaultTimeout(20_000)

const dir = mkdtempSync(join(tmpdir(), 'stall-'))
const spin = join(dir, 'spin.test.ts')
const pass = join(dir, 'pass.test.ts')
const workerPid = join(dir, 'worker.pid')
writeFileSync(
  spin,
  `import { test } from 'bun:test'
import { writeFileSync } from 'node:fs'
test('spin', () => {
  writeFileSync(${JSON.stringify(workerPid)}, String(process.pid))
  while (true) {}
})
`,
)
writeFileSync(pass, `import { test } from 'bun:test'\ntest('pass', () => {})\n`)

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterAll(() => {
  try {
    process.kill(Number(readFileSync(workerPid, 'utf8')), 'SIGKILL')
  } catch {}
  rmSync(dir, { recursive: true, force: true })
})

const runTestScript = async (files: string[], env: Record<string, string> = {}) => {
  const run = Bun.spawn([process.execPath, join(import.meta.dir, 'test.ts'), ...files], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()])
  return { code, stderr }
}

test('進捗が止まった bun test を kill し、終わっていない test file だけを出して失敗する', async () => {
  const { code, stderr } = await runTestScript([spin, pass], { MONICA_TEST_STALL_MS: '3000' })

  // GitHub Actions では reporter が通った file の名前も出すので、watchdog が出した一覧だけを見る。
  const unfinished = stderr.slice(stderr.indexOf('終わっていない test file:'))
  expect(code).not.toBe(0)
  expect(unfinished).toContain('spin.test.ts')
  expect(unfinished).not.toContain('pass.test.ts')
  const pid = Number(readFileSync(workerPid, 'utf8'))
  const deadline = Date.now() + 2000
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(50)
  expect(isAlive(pid)).toBe(false)
})

test('普通に終わる run は進捗の file を TMPDIR の残り物として出さない', async () => {
  const { code, stderr } = await runTestScript([pass])

  expect(stderr).not.toContain('TMPDIR に残した')
  expect(code).toBe(0)
})
