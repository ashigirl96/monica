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
      signal: aborted,
    },
  )
  // rc が背景に起こした子は shell を kill しても stdout を握り続けるので、出力の EOF は打ち切りと競わせる。
  const finished = await Promise.race([
    Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]),
    untilAborted(aborted),
  ])
  if (timeout.aborted) throw new Error(`${shell} -ilc took over ${TIMEOUT_MS}ms`)
  if (!finished) throw new Error(`${shell} -ilc was stopped`)
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

function untilAborted(signal: AbortSignal): Promise<undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(undefined), { once: true }),
  )
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
