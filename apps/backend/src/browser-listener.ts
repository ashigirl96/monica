import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { IMAGE_URL_PREFIX, NOTES_HOSTNAMES } from '@monica/note/contract'
import { router as noteRouter } from '@monica/note/server'
import { type InferRouterInitialContext, os } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { type Context, Hono } from 'hono'

const IMMUTABLE = 'public, max-age=31536000, immutable'

type BrowserContext = InferRouterInitialContext<typeof noteRouter>

type Deps = {
  context: BrowserContext
  webDist: string
}

export function listenBrowser(
  port: string | undefined,
  { context, webDist }: Deps,
): { stop(): void } | null {
  if (!port) return null
  // DNS rebinding で別の名前から届いた request を止める。
  const hosts = new Set(NOTES_HOSTNAMES.map((name) => `${name}:${port}`))
  // openTab の input は shell に打鍵されるので、token の無い口に workbench・task・job を載せると任意のコマンドになる（ADR-0017）。
  // chat は Current Page を送るので、port を先に握った別の process に渡さないよう token の口に載せる（ADR-0034）。
  const handler = new RPCHandler(os.$context<BrowserContext>().router({ note: noteRouter }))

  const app = new Hono()
  app.use('*', async (c, next) => {
    if (!hosts.has(c.req.header('host') ?? '')) return c.text('Forbidden', 403)
    if (c.req.method !== 'GET' && !fromSameOriginOrExtension(c)) return c.text('Forbidden', 403)
    return next()
  })
  app.use('/rpc/*', async (c) => {
    const { matched, response } = await handler.handle(c.req.raw, { prefix: '/rpc', context })
    return matched ? c.newResponse(response.body, response) : c.notFound()
  })
  app.get(`${IMAGE_URL_PREFIX}*`, (c) =>
    context.noteLedger.serveImage(c.req.path.slice(IMAGE_URL_PREFIX.length)),
  )
  app.get('*', spa(webDist))

  // 両方の loopback で bind し、片方だけを他の process が握っている衝突も EADDRINUSE で見つける。
  const servers: Bun.Server<undefined>[] = []
  try {
    for (const hostname of ['127.0.0.1', '::1']) {
      servers.push(
        Bun.serve({
          hostname,
          port: Number(port),
          idleTimeout: 0,
          fetch: app.fetch,
        }),
      )
    }
  } catch (error) {
    for (const server of servers) void server.stop(true)
    console.error(`[backend] no browser listener on port ${port}: ${(error as Error).message}`)
    return null
  }
  return {
    stop() {
      for (const server of servers) void server.stop(true)
    },
  }
}

// token の代わりに CSRF を止める。port を見ない same-site は localhost の別の app からも付き、
// none は user の navigation にも付くので、Chrome Extension の fetch が作る cors との組だけを通す（ADR-0028）。
function fromSameOriginOrExtension(c: Context): boolean {
  const site = c.req.header('sec-fetch-site')
  return site === 'same-origin' || (site === 'none' && c.req.header('sec-fetch-mode') === 'cors')
}

// 配るのは build の出力に在る file だけなので、path を file system の path として解かない。
function spa(webDist: string): (c: Context) => Response {
  const files = new Map(
    existsSync(webDist)
      ? [...new Bun.Glob('**/*').scanSync({ cwd: webDist })].map((path) => [
          `/${path}`,
          join(webDist, path),
        ])
      : [],
  )
  return (c) => {
    const file = files.get(c.req.path)
    // Vite は hash を付けた file を assets/ に出す。
    if (file) return serve(file, c.req.path.startsWith('/assets/') ? IMMUTABLE : 'no-cache')
    const index = files.get('/index.html')
    if (!index) return c.text('This Backend does not carry the notes screens', 404)
    return serve(index, 'no-cache')
  }
}

function serve(file: string, cacheControl: string): Response {
  return new Response(Bun.file(file), { headers: { 'cache-control': cacheControl } })
}
