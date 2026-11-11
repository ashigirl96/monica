import { expect, test } from 'bun:test'

import { ORPCError } from '@orpc/client'

import type { StudyMessage } from '../contract.ts'
import { createStudyStarter } from './new-study.ts'

const row = (id: string, text: string): StudyMessage => ({
  id: 1,
  conversationId: `conversation-of-${id}`,
  kind: 'user',
  text,
  tool: null,
  reason: null,
  state: null,
  createdAt: new Date(),
})

test('after start succeeds and send fails, the next try sends to the same Study without starting another', async () => {
  const started: string[] = []
  const sent: { id: string; text: string }[] = []
  let failSend = true
  const starter = createStudyStarter({
    async start() {
      const id = `study-${started.length + 1}`
      started.push(id)
      return { id }
    },
    async send({ id, text }) {
      sent.push({ id, text })
      if (failSend) throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'down' })
      return { message: row(id, text) }
    },
  })

  await expect(starter.begin('learn ky')).rejects.toThrow('down')
  failSend = false
  await expect(starter.begin('learn ky again')).resolves.toBe('study-1')

  expect(started).toEqual(['study-1'])
  expect(sent).toEqual([
    { id: 'study-1', text: 'learn ky' },
    { id: 'study-1', text: 'learn ky again' },
  ])
})
