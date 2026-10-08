import { createORPCClient, RPCLink } from './rpc.js'

// manifest の host_permissions には 127.0.0.1 と monica.localhost だけを書き、localhost は書かない。
export const DEFAULTS = { echo: '47951' }

export async function loadConfig() {
  const { cfg } = await chrome.storage.local.get('cfg')
  return { ...DEFAULTS, ...cfg }
}

async function attempt(name, url, init) {
  try {
    const res = await fetch(url, init)
    let body
    try {
      body = (await res.text()).slice(0, 800)
    } catch (error) {
      body = `unreadable: ${error}`
    }
    return { name, status: res.status, type: res.type, body }
  } catch (error) {
    return { name, error: String(error) }
  }
}

async function call(name, fn) {
  try {
    return { name, ok: true, value: JSON.stringify(await fn()).slice(0, 300) }
  } catch (error) {
    return { name, ok: false, error: String(error), code: error?.code, status: error?.status }
  }
}

const json = (headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: '{"json":null}',
})

export async function runProbes(ctx, cfg) {
  const e = cfg.echo
  const at = (host, name) => `http://${host}:${e}/echo?c=${ctx}-${name}`
  const results = [
    await attempt('get-127', at('127.0.0.1', 'get-127')),
    await attempt('post-json-127', at('127.0.0.1', 'post-json-127'), json()),
    await attempt('post-bearer-127', at('127.0.0.1', 'post-bearer-127'), json({ authorization: 'Bearer x' })),
    await attempt('get-monica.localhost', at('monica.localhost', 'get-monica.localhost')),
    await attempt('post-json-monica.localhost', at('monica.localhost', 'post-json-monica.localhost'), json()),
    await attempt('get-localhost-no-host-permission', at('localhost', 'get-localhost-no-host-permission')),
    await attempt('post-json-localhost-no-host-permission', at('localhost', 'post-json-localhost-no-host-permission'), json()),
    await attempt('forged-headers', at('127.0.0.1', 'forged-headers'), {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin', origin: 'http://monica.localhost:19380' },
      body: 'x',
    }),
  ]
  for (const name of ['local-network-access', 'local-network', 'loopback-network']) {
    try {
      results.push({ name: `permission-${name}`, state: (await navigator.permissions.query({ name })).state })
    } catch (error) {
      results.push({ name: `permission-${name}`, error: String(error) })
    }
  }

  if (cfg.notes) {
    for (const host of ['127.0.0.1', 'monica.localhost']) {
      const notes = createORPCClient(new RPCLink({ url: `http://${host}:${cfg.notes}/rpc` }))
      results.push(await call(`rpc-notes-${host}`, () => notes.note.daily.dates()))
    }
    const forged = createORPCClient(
      new RPCLink({ url: `http://127.0.0.1:${cfg.notes}/rpc`, headers: { 'sec-fetch-site': 'same-origin' } }),
    )
    results.push(await call('rpc-notes-forged-sec-fetch-site', () => forged.note.daily.dates()))
  }
  if (cfg.api) {
    const anonymous = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${cfg.api}/rpc` }))
    results.push(await call('rpc-api-without-token', () => anonymous.workbench.layout.get()))
    if (cfg.token) {
      const api = createORPCClient(
        new RPCLink({ url: `http://127.0.0.1:${cfg.api}/rpc`, headers: { authorization: `Bearer ${cfg.token}` } }),
      )
      results.push(await call('rpc-api-with-token', () => api.workbench.layout.get()))
      results.push(
        await call('rpc-api-event-iterator-opens', async () => {
          const changes = await api.workbench.changes()
          await changes.return()
          return 'opened'
        }),
      )
    }
  }

  const echo = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${e}/orpc` }))
  results.push(
    await call('rpc-echo-event-iterator-3', async () => {
      const got = []
      for await (const n of await echo.tick()) {
        got.push(n)
        if (got.length === 3) break
      }
      return got
    }),
  )

  await report(cfg, { ctx, results })
  return results
}

// 閉じたときに Backend 側で切断に気づけるかを見るため、読み続ける stream を 2 本張る。
export function holdStreams(ctx, cfg) {
  const e = cfg.echo
  void (async () => {
    const res = await fetch(`http://127.0.0.1:${e}/sse?id=${ctx}-long`)
    const reader = res.body.getReader()
    while (!(await reader.read()).done) {
      // 読み捨てる
    }
  })()
  void (async () => {
    const echo = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${e}/orpc` }))
    for await (const _ of await echo.tick()) {
      // 読み捨てる
    }
  })()
}

export function report(cfg, body) {
  return fetch(`http://127.0.0.1:${cfg.echo}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {})
}
