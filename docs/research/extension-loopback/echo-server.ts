// 拡張から届いた request の header を記録して返す server。
// usage: bun docs/research/extension-loopback/echo-server.ts <port> > echo.jsonl
// oRPC は repo の root に無いので、apps/backend が解決した版を相対 path で読む。
import { os } from '../../../apps/backend/node_modules/@orpc/server/dist/index.mjs'
import { RPCHandler } from '../../../apps/backend/node_modules/@orpc/server/dist/adapters/fetch/index.mjs'

const port = Number(process.argv[2] ?? 47951)
const started = Date.now()
const log = (line: object) => console.log(JSON.stringify({ t: Date.now() - started, ...line }))

const pick = (req: Request) => {
  const keep = ['host', 'origin', 'referer', 'authorization', 'content-type', 'access-control-request-method', 'access-control-request-headers', 'access-control-request-private-network', 'access-control-request-local-network', 'user-agent']
  return Object.fromEntries([...req.headers].filter(([k]) => k.startsWith('sec-') || keep.includes(k)))
}

const handler = new RPCHandler(
  os.router({
    tick: os.handler(async function* ({ signal }) {
      log({ kind: 'orpc-tick-open' })
      let n = 0
      try {
        while (!signal?.aborted) {
          yield n++
          await Bun.sleep(1000)
        }
      } finally {
        log({ kind: 'orpc-tick-finally', sent: n })
      }
    }),
  }),
)

async function fetch(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const headers = pick(req)
  if (req.method === 'OPTIONS') {
    log({ kind: 'preflight', path: url.pathname + url.search, headers })
    return new Response(null, { status: 204 })
  }
  if (url.pathname.startsWith('/orpc/')) {
    log({ kind: 'orpc', path: url.pathname, headers })
    const { response } = await handler.handle(req, { prefix: '/orpc' })
    return response ?? new Response('no procedure', { status: 404 })
  }
  if (url.pathname === '/report') {
    log({ kind: 'report', body: await req.json() })
    return new Response('ok')
  }
  if (url.pathname === '/sse') {
    const id = url.searchParams.get('id')
    log({ kind: 'sse-open', id, headers })
    const opened = Date.now()
    let n = 0
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async pull(controller) {
        if (req.signal.aborted) return
        controller.enqueue(encoder.encode(`data: ${n++}\n\n`))
        await Bun.sleep(1000)
      },
    })
    req.signal.addEventListener('abort', () => log({ kind: 'sse-abort', id, sent: n, ms: Date.now() - opened }))
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text()
  log({ kind: 'request', method: req.method, path: url.pathname + url.search, headers, body: body.slice(0, 200) })
  return Response.json({ method: req.method, path: url.pathname + url.search, headers })
}

// monica.localhost は ::1 から先に引かれるので、notes の口と同じく両方で bind する。
for (const hostname of ['127.0.0.1', '::1']) Bun.serve({ hostname, port, idleTimeout: 0, fetch })
console.error(`[echo] listening on ${port}`)
