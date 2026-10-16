import { homedir, userInfo } from 'node:os'

const DELIMITER = '_MONICA_PATH_DELIMITER_'
const TIMEOUT_MS = 5000
const REREAD_MS = 30_000

type Env = Record<string, string | undefined>

// .app から起動した Backend は launchd の最小の PATH しか持たず、gh・git・ghq・setup script の中の bun や mise が見つからない。
export async function loginShellPath(
  env: Env = process.env,
  signal?: AbortSignal,
): Promise<string> {
  const shell = env.SHELL || userInfo().shell || '/bin/zsh'
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const aborted = signal ? AbortSignal.any([timeout, signal]) : timeout
  const child = Bun.spawn(
    [shell, '-ilc', `printf '%s' '${DELIMITER}'; printf '%s' "$PATH"; printf '%s' '${DELIMITER}'`],
    {
      cwd: env.HOME || homedir(),
      // Oh My Zsh の自動更新の問い合わせは、答えが来るまで shell を止める。
      env: { ...env, DISABLE_AUTO_UPDATE: 'true' },
      // Backend の stdin は Shell の死を EOF で知らせる pipe なので、rc に読ませない。
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // 打ち切った shell は、rc が起こした子ごと group で kill する。読み直しのたびに残ると溜まり続けるため。
      detached: true,
    },
  )
  // Backend の exit は止めた直後に process.exit するので、kill は abort の中で同期に送る。
  const { promise: killed, resolve: settleKilled } = Promise.withResolvers<undefined>()
  const kill = () => {
    killGroup(child.pid)
    settleKilled(undefined)
  }
  if (aborted.aborted) kill()
  else aborted.addEventListener('abort', kill, { once: true })
  let finished
  try {
    // setsid した子孫は group の kill を逃れて出力を握り続けるので、EOF は kill と競わせる。
    finished = await Promise.race([
      Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]),
      killed,
    ])
  } finally {
    // 終わった shell の pgid は別の process が使い回すので、後から来る timeout で kill しない。
    aborted.removeEventListener('abort', kill)
  }
  if (!finished) {
    throw new Error(
      timeout.aborted ? `${shell} -ilc took over ${TIMEOUT_MS}ms` : `${shell} -ilc was stopped`,
    )
  }
  const [exitCode, stdout, stderr] = finished
  if (exitCode !== 0) {
    throw new Error(
      `${shell} -ilc exited with ${exitCode}: ${stderr.trim().replaceAll(/\s*\n\s*/g, ' ')}`,
    )
  }
  const path = stdout.split(DELIMITER)[1]
  if (!path) throw new Error(`${shell} -ilc printed no PATH`)
  return path
}

function killGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // group はもう居ない。
  }
}

export function rereadLoginShellPath(apply: (path: string) => void, env: Env = process.env) {
  const stopping = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let retry = 0
  async function read() {
    retry += 1
    try {
      apply(await loginShellPath(env, stopping.signal))
      console.error(`[backend] read the login shell's PATH on retry ${retry}`)
    } catch (error) {
      if (stopping.signal.aborted) return
      console.error(
        `[backend] retry ${retry} could not read the login shell's PATH: ${(error as Error).message}`,
      )
      timer = setTimeout(read, REREAD_MS)
    }
  }
  timer = setTimeout(read, REREAD_MS)
  return () => {
    stopping.abort()
    clearTimeout(timer)
  }
}
