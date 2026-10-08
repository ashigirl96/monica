import { homedir, userInfo } from 'node:os'

const DELIMITER = '_MONICA_PATH_DELIMITER_'
const TIMEOUT_MS = 5000

// .app から起動した Backend は launchd の最小の PATH しか持たず、gh・git・ghq・setup script の中の bun や mise が見つからない。
export function loginShellPath(env: Record<string, string | undefined> = process.env): string {
  const shell = env.SHELL || userInfo().shell || '/bin/zsh'
  const result = Bun.spawnSync(
    [shell, '-ilc', `printf '%s' '${DELIMITER}'; printf '%s' "$PATH"; printf '%s' '${DELIMITER}'`],
    {
      cwd: env.HOME || homedir(),
      // Oh My Zsh の自動更新の問い合わせは、答えが来るまで shell を止める。
      env: { ...env, DISABLE_AUTO_UPDATE: 'true' },
      // Backend の stdin は Shell の死を EOF で知らせる pipe なので、rc に読ませない。
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: TIMEOUT_MS,
    },
  )
  if (result.exitedDueToTimeout) throw new Error(`${shell} -ilc took over ${TIMEOUT_MS}ms`)
  if (!result.success) {
    const stderr = result.stderr
      .toString()
      .trim()
      .replaceAll(/\s*\n\s*/g, ' ')
    throw new Error(`${shell} -ilc exited with ${result.exitCode}: ${stderr}`)
  }
  const path = result.stdout.toString().split(DELIMITER)[1]
  if (!path) throw new Error(`${shell} -ilc printed no PATH`)
  return path
}
