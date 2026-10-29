import { appendFileSync } from 'node:fs'

const serve = Bun.serve
const loopbackServe: typeof Bun.serve = (options) => {
  if ('tls' in options && options.tls) {
    appendFileSync(
      process.env.MONICA_TEST_REMOTE_BIND_LOG!,
      JSON.stringify({ address: options.hostname, port: options.port }) + '\n',
    )
    Object.assign(options, { hostname: '127.0.0.1' })
  }
  return serve(options)
}
Bun.serve = loopbackServe
