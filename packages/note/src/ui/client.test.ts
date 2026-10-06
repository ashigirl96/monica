import { afterEach, expect, mock, spyOn, test } from 'bun:test'

import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'

import { linkOptions, type NoteClient } from './client.ts'

afterEach(() => {
  mock.restore()
})

function setup(first: () => Promise<Response>) {
  const backend = { respond: first }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((() =>
    backend.respond()) as unknown as typeof globalThis.fetch)
  const reach = { reached: mock(() => {}), failed: mock(() => {}) }
  const client: NoteClient = createORPCClient(
    new RPCLink({ url: 'http://notes.test/rpc', ...linkOptions(reach) }),
  )
  return { client, fetch, reach, backend }
}

const answer = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  )

test('a call made with keepalive in its context goes out as a keepalive fetch, and other calls do not', async () => {
  const { client, fetch } = setup(answer(200, { json: [] }))

  await client.daily.dates(undefined, { context: { keepalive: true } })
  await client.daily.dates()

  expect(fetch.mock.calls.map(([, init]) => init?.keepalive)).toEqual([true, undefined])
})

test('any answer from the Backend, an error too, is a reach; no answer at all is a failure', async () => {
  const { client, reach, backend } = setup(answer(200, { json: [] }))

  await client.daily.dates()
  backend.respond = answer(409, {
    json: { defined: true, code: 'CONFLICT', status: 409, message: 'stale' },
  })
  const conflict = await client.daily.dates().catch((error: unknown) => error)
  expect(reach.reached).toHaveBeenCalledTimes(2)
  expect(conflict).toBeInstanceOf(ORPCError)

  backend.respond = () => Promise.reject(new TypeError('Failed to fetch'))
  const failure = await client.daily.dates().catch((error: unknown) => error)

  expect(reach.failed).toHaveBeenCalledTimes(1)
  expect(reach.reached).toHaveBeenCalledTimes(2)
  expect(failure).toBeInstanceOf(TypeError)
})

test('a call that is aborted is neither a reach nor a failure', async () => {
  const { client, reach } = setup(() =>
    Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
  )

  await client.daily.dates().catch(() => {})

  expect(reach.reached).not.toHaveBeenCalled()
  expect(reach.failed).not.toHaveBeenCalled()
})
