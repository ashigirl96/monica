import { z } from 'zod'

/** Native Messaging の host が返す、Backend の token の口の port と Chrome Extension の token（ADR-0034）。 */
const AddressSchema = z.object({ port: z.number(), token: z.string() })

type Address = z.infer<typeof AddressSchema>

/** host が無い・落ちた・Backend が居ない。fetch の TypeError と同じく「desktop に届かない」に数える。 */
export class BackendUnreachable extends Error {
  override name = 'BackendUnreachable'
}

/**
 * RPCLink の url と headers。呼ぶたびに host に問い合わせ、Backend の起き直しで変わる port と token を覚えない。
 * oRPC は 1 回の呼び出しの url と headers に同じ options を渡すので、それを key にして問い合わせを 1 回にする。
 */
export function viaNativeHost(host: string): {
  url: (options: object) => Promise<string>
  headers: (options: object) => Promise<Record<string, string>>
} {
  const asked = new WeakMap<object, Promise<Address>>()
  const addressFor = (options: object) => {
    const known = asked.get(options)
    if (known) return known
    const address = ask(host)
    asked.set(options, address)
    return address
  }
  return {
    url: async (options) => `http://127.0.0.1:${(await addressFor(options)).port}/rpc`,
    headers: async (options) => ({ authorization: `Bearer ${(await addressFor(options)).token}` }),
  }
}

async function ask(host: string): Promise<Address> {
  let reply: unknown
  try {
    reply = await chrome.runtime.sendNativeMessage(host, {})
  } catch (error) {
    throw new BackendUnreachable(error instanceof Error ? error.message : String(error))
  }
  const address = AddressSchema.safeParse(reply)
  if (!address.success) throw new BackendUnreachable('the monica desktop is not running')
  return address.data
}
