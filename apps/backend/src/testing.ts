// notes の口は 127.0.0.1 と ::1 の同じ port で bind するので、port 0 は使えない。
export function freePort(): number {
  const probe = Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response() })
  const { port } = probe
  void probe.stop(true)
  return port!
}
