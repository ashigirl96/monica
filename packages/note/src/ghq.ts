export type Ghq = {
  root(): Promise<string>
}

export const defaultGhq: Ghq = {
  async root() {
    const child = Bun.spawn(['ghq', 'root'], {
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`ghq root failed: ${stderr.trim() || `exit ${exitCode}`}`)
    return stdout.trim()
  },
}
