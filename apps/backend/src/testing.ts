// notes の口は 127.0.0.1 と ::1 の同じ port で bind するので、port 0 は使えず、両方で空いている port を選ぶ。
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
