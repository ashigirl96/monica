// ブラウザの口は 127.0.0.1 と ::1 の同じ port で bind するので、port 0 は使えず、両方で空いている port を選ぶ。
export function freePort(): number {
  for (;;) {
    const v6 = Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response() })
    try {
      const v4 = Bun.serve({ hostname: '127.0.0.1', port: v6.port, fetch: () => new Response() })
      void v4.stop(true)
      return v6.port!
    } catch {
      // 127.0.0.1 側だけを他の process が握っている。
    } finally {
      void v6.stop(true)
    }
  }
}

/** kill した process は reap されるまで残るので、居なくなるのを 2 秒まで待つ。 */
export async function untilGone(pid: number) {
  const deadline = Date.now() + 2000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() >= deadline) return false
    await Bun.sleep(20)
  }
}
