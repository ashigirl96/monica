type FakePage = {
  status?: number
  headers?: Record<string, string>
  body?: string | Uint8Array
  /** body の後に、client が読むのをやめるまで空白を送り続けるか、何も送らずに閉じないでおく。 */
  rest?: 'endless' | 'stalled'
}

const CHUNK = new Uint8Array(64 * 1024).fill(0x20)

export function startFakeSite() {
  const pages = new Map<string, FakePage>()
  const requests: { path: string; userAgent: string | null }[] = []
  const cancelled: string[] = []
  let held: Promise<void> | null = null

  function stream(path: string, { body, rest }: FakePage): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        if (body !== undefined) {
          controller.enqueue(typeof body === 'string' ? new TextEncoder().encode(body) : body)
        }
        if (rest === undefined) controller.close()
      },
      async pull(controller) {
        if (rest === 'stalled') await new Promise(() => {})
        controller.enqueue(CHUNK)
      },
      cancel() {
        cancelled.push(path)
      },
    })
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const { pathname, search } = new URL(request.url)
      const path = pathname + search
      requests.push({ path, userAgent: request.headers.get('user-agent') })
      await held
      const page = pages.get(path)
      if (!page) return new Response('Not Found', { status: 404 })
      return new Response(stream(path, page), {
        status: page.status ?? 200,
        headers: page.headers ?? { 'content-type': 'text/html' },
      })
    },
  })

  return {
    url: (path: string) => `http://127.0.0.1:${server.port}${path}`,
    requests,
    /** client が body を読み切らずにやめた page の path。 */
    cancelled,
    page(path: string, page: FakePage) {
      pages.set(path, page)
    },
    /** release するまで、届いた request に header を返さない。 */
    hold(): () => void {
      let release!: () => void
      held = new Promise((resolve) => (release = resolve))
      return () => {
        held = null
        release()
      }
    },
    stop: () => server.stop(true),
  }
}

export type FakeSite = ReturnType<typeof startFakeSite>
