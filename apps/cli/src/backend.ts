import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createORPCClient } from '@orpc/client'
import type { ClientLink } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'

import type { contract } from './contract.ts'

export type Client = ContractRouterClient<typeof contract>

type Endpoint = { port: number; token: string; pid: number }

export class BackendNotRunning extends Error {
  constructor() {
    super('BACKEND_NOT_RUNNING: start the tania desktop app')
  }
}

const RETRY_INTERVAL_MS = 200
const RETRY_WINDOW_MS = 3000

export function connect(home: string, { retry = true }: { retry?: boolean } = {}): Client | null {
  if (!liveEndpoint(home)) return null
  // oRPC の client context が空であることを表す型なので、`{}` に解決されるのが意図どおり。
  // oxlint-disable-next-line typescript/no-generated-empty-object-type
  const link: ClientLink<Record<never, never>> = {
    async call(path, input, options) {
      const deadline = Date.now() + RETRY_WINDOW_MS
      for (;;) {
        const endpoint = liveEndpoint(home)
        if (!endpoint) throw new BackendNotRunning()
        const rpc = new RPCLink({
          url: `http://127.0.0.1:${endpoint.port}/rpc`,
          headers: { authorization: `Bearer ${endpoint.token}` },
        })
        try {
          return await rpc.call(path, input, options)
        } catch (error) {
          // bind 前と再起動中の Backend は接続を拒む。再起動すると port が変わるので file から読み直す。
          if (!isRefused(error)) throw error
          if (!retry || Date.now() >= deadline) throw new BackendNotRunning()
          await Bun.sleep(RETRY_INTERVAL_MS)
        }
      }
    },
  }
  return createORPCClient(link)
}

function liveEndpoint(home: string): Endpoint | null {
  let endpoint: Endpoint
  try {
    endpoint = JSON.parse(readFileSync(join(home, 'backend.json'), 'utf8'))
  } catch {
    return null
  }
  return isAlive(endpoint.pid) ? endpoint : null
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isRefused(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ConnectionRefused'
}
