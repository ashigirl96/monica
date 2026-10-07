export type Ghq = {
  /** `ghq list` の行。ghq の root からの path（`github.com/owner/repo`）。 */
  list(signal: AbortSignal): Promise<string[]>
}

export const defaultGhq: Ghq = {
  async list(signal) {
    const child = Bun.spawn(['ghq', 'list'], {
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    signal.throwIfAborted()
    if (exitCode !== 0) throw new Error(`ghq list failed: ${stderr.trim() || `exit ${exitCode}`}`)
    return stdout.split('\n').filter((line) => line !== '')
  },
}
