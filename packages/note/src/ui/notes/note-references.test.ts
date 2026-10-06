import { afterEach, expect, mock, spyOn, test } from 'bun:test'

import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'

import { linkOptions, type NoteClient } from '../client.ts'
import { Reach } from '../reach.ts'
import { noteReferences } from './note-references.ts'

afterEach(() => {
  mock.restore()
})

type Answer = () => Promise<Response>

const answer =
  (status: number, json: unknown): Answer =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify({ json }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )

const notFound = answer(404, {
  defined: false,
  code: 'NOT_FOUND',
  status: 404,
  message: 'no Note is note-9',
})

const unreachable: Answer = () => Promise.reject(new TypeError('Failed to fetch'))

function setup(flush: () => Promise<void> = () => Promise.resolve()) {
  const answers = new Map<string, Answer>()
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(((request: Request) => {
    const respond = answers.get(new URL(request.url).pathname)
    if (respond === undefined) throw new Error(`no answer for ${request.url}`)
    return respond()
  }) as unknown as typeof globalThis.fetch)
  const reach = new Reach()
  const client: NoteClient = createORPCClient(
    new RPCLink({ url: 'http://notes.test/rpc', ...linkOptions(reach) }),
  )
  const open = () => noteReferences({ client, reach, flush })
  const paths = () =>
    fetch.mock.calls.map(([request]) => new URL((request as Request).url).pathname)
  return { answers, client, open, paths, reach }
}

function settledYet(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    Bun.sleep(10).then(() => false),
  ])
}

test('the candidates for `[[` are what the Backend finds for the query', async () => {
  const { answers, open, paths } = setup()
  const candidates = [{ id: 'note-1', displayName: 'On ledgers', preview: 'first line' }]
  answers.set('/rpc/noteMention/search', answer(200, candidates))

  expect(await open().searchNoteMentions('ledg')).toEqual(candidates)
  expect(paths()).toEqual(['/rpc/noteMention/search'])
})

test('a Note Mention to a Note the Backend does not find resolves to none, which the editor shows as a deleted Note', async () => {
  const { answers, open } = setup()
  answers.set('/rpc/noteMention/resolve', notFound)

  expect(await open().resolveNoteMention('note-9')).toBeNull()
})

test('a Note Mention the Backend fails on otherwise is an error, which the editor leaves unresolved rather than deleted', async () => {
  const { answers, open } = setup()
  answers.set(
    '/rpc/noteMention/resolve',
    answer(500, { defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'boom' }),
  )

  await expect(open().resolveNoteMention('note-3')).rejects.toBeInstanceOf(ORPCError)
})

test('a Note Mention that cannot reach the Backend stays unresolved without asking again, and resolves to the name once the Backend is reached again', async () => {
  const { answers, client, open, paths } = setup()
  answers.set('/rpc/noteMention/resolve', unreachable)
  answers.set('/rpc/daily/dates', unreachable)

  const name = open().resolveNoteMention('note-3')

  expect(await settledYet(name)).toBe(false)
  expect(paths()).toEqual(['/rpc/noteMention/resolve'])

  answers.set('/rpc/noteMention/resolve', answer(200, { displayName: 'On ledgers' }))
  answers.set('/rpc/daily/dates', answer(200, []))
  await client.daily.dates()

  expect(await name).toEqual({ displayName: 'On ledgers' })
})

test('a Note Mention asks again at once when another request gets through between its failure and its waiting', async () => {
  const { answers, open, reach } = setup()
  let asked = 0
  answers.set('/rpc/noteMention/resolve', () =>
    asked++ === 0 ? unreachable() : answer(200, { displayName: 'On ledgers' })(),
  )
  const failed = reach.failed.bind(reach)
  reach.failed = () => {
    failed()
    reach.reached()
  }

  const name = open().resolveNoteMention('note-3')

  expect(await settledYet(name)).toBe(true)
  expect(await name).toEqual({ displayName: 'On ledgers' })
})

test('the name of a Note Mention is asked once while the Note is open, and anew when it is opened again', async () => {
  const { answers, open, paths } = setup()
  answers.set('/rpc/noteMention/resolve', answer(200, { displayName: 'Old title' }))
  const opened = open()

  await opened.resolveNoteMention('note-3')
  answers.set('/rpc/noteMention/resolve', answer(200, { displayName: 'New title' }))

  expect(await opened.resolveNoteMention('note-3')).toEqual({ displayName: 'Old title' })
  expect(await open().resolveNoteMention('note-3')).toEqual({ displayName: 'New title' })
  expect(paths()).toEqual(['/rpc/noteMention/resolve', '/rpc/noteMention/resolve'])
})

test('a Synced Block asks for its block only once the unsaved edits are saved; a block the Backend does not find is none, and a failure to reach it is an error', async () => {
  const saved = Promise.withResolvers<void>()
  const { answers, open, paths } = setup(() => saved.promise)
  const block = { type: 'blockContainer', attrs: { id: 'b1' }, content: [] }
  answers.set('/rpc/block/get', answer(200, block))
  const { resolveBlock } = open()

  const resolved = resolveBlock('note-3', 'b1')

  expect(await settledYet(resolved)).toBe(false)
  expect(paths()).toEqual([])

  saved.resolve()

  expect(await resolved).toEqual(block)
  expect(paths()).toEqual(['/rpc/block/get'])

  answers.set('/rpc/block/get', notFound)
  expect(await resolveBlock('note-3', 'b2')).toBeNull()

  answers.set('/rpc/block/get', unreachable)
  await expect(resolveBlock('note-3', 'b1')).rejects.toBeInstanceOf(TypeError)
})
