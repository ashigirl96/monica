import { afterEach, expect, test } from 'bun:test'
import { connect } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { startFakePtyd, tempHome } from './fake-ptyd.ts'
import type { RequestOp, ServerMessage } from './ptyd.ts'
import { cleanUp, onCleanup } from './testing.ts'

afterEach(cleanUp)

async function fixture() {
  const home = tempHome(onCleanup)
  const fake = startFakePtyd(home)
  onCleanup(() => fake.stop())
  const socket = connect(join(home, 'ptyd.sock'))
  const lines = createInterface({ input: socket })
  const messages = lines[Symbol.asyncIterator]()
  onCleanup(() => {
    lines.close()
    socket.destroy()
  })
  let id = 0
  async function request(op: RequestOp) {
    id++
    socket.write(`${JSON.stringify({ ...op, id })}\n`)
    for (;;) {
      const line = await messages.next()
      if (line.done) throw new Error('unexpected ptyd EOF')
      const message = JSON.parse(line.value) as ServerMessage
      if ((message.type === 'ok' || message.type === 'err') && message.id === id) return message
    }
  }
  expect(await request({ op: 'hello', version: 1 })).toMatchObject({ body: 'hello', version: 1 })
  await request({
    op: 'create',
    session_id: 'shared',
    cwd: home,
    shell: null,
    rows: 31,
    cols: 97,
    env: null,
  })
  fake.output('shared', 'retained-marker\r\n')
  return { fake, request }
}

test('Attach replay_bytes zero returns no retained body, a limit returns its suffix and omission returns the tail', async () => {
  const { request } = await fixture()
  for (const [replay_bytes, expected] of [
    [0, ''],
    [6, 'rker\r\n'],
    [undefined, 'retained-marker\r\n'],
  ] as const) {
    const reply = await request({ op: 'attach', session_id: 'shared', replay_bytes })
    if (reply.type !== 'ok' || reply.body !== 'attached') throw new Error('Attach failed')
    expect(Buffer.from(reply.replay, 'base64').toString()).toBe(expected)
    expect([reply.rows, reply.cols]).toEqual([31, 97])
  }
})

test('Attach to an exited session is refused even when its transcript is retained', async () => {
  const { fake, request } = await fixture()
  fake.exit('shared', 7)
  expect(await request({ op: 'attach', session_id: 'shared' })).toEqual({
    type: 'err',
    id: 3,
    error: 'session shared has exited',
  })
})
