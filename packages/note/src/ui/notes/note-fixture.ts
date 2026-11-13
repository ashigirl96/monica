import { expect } from 'bun:test'

import type { Doc } from '../../contract.ts'
import type { NoteClient } from '../client.ts'

export const cleanups: (() => void)[] = []

export function fakeBrowser() {
  if ('window' in globalThis) return
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true })
  Object.defineProperty(globalThis, 'document', {
    value: { visibilityState: 'visible' },
    configurable: true,
  })
  cleanups.push(() => {
    Reflect.deleteProperty(globalThis, 'window')
    Reflect.deleteProperty(globalThis, 'document')
  })
}

export const doc = (text: string): Doc => ({
  type: 'doc',
  content: [
    {
      type: 'blockGroup',
      content: [
        {
          type: 'blockContainer',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        },
      ],
    },
  ],
})

export async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(1)
  expect(condition()).toBe(true)
}

type Held = { entered: Promise<void>; release: () => void; fail: () => void }

/** procedure を 1 度だけ途中で止める client。止めた所で競合を起こし、返すか断るかを選ぶ。 */
export function holdable(backend: NoteClient) {
  const holds = new Map<string, { entered: () => void; gate: Promise<void> }>()
  const calls: string[] = []
  const wrap =
    <I, O>(name: string, procedure: (input: I) => Promise<O>) =>
    async (input: I): Promise<O> => {
      calls.push(name)
      const held = holds.get(name)
      if (held !== undefined) {
        holds.delete(name)
        held.entered()
        await held.gate
      }
      return procedure(input)
    }
  const hold = (name: 'get' | 'save' | 'remove' | 'essay.setStatus'): Held => {
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    holds.set(name, { entered: entered.resolve, gate: gate.promise })
    return {
      entered: entered.promise,
      release: () => gate.resolve(),
      fail: () => gate.reject(new Error('unreachable')),
    }
  }
  const essay = new Proxy(backend.essay, {
    get: (target, key) =>
      key === 'setStatus' ? wrap('essay.setStatus', target.setStatus) : Reflect.get(target, key),
  })
  const procedures: Record<string, unknown> = {
    get: wrap('get', backend.get),
    save: wrap('save', backend.save),
    remove: wrap('remove', backend.remove),
    restore: wrap('restore', backend.restore),
    star: wrap('star', backend.star),
    essay,
  }
  const client = new Proxy(backend, {
    get: (target, key) =>
      typeof key === 'string' && key in procedures ? procedures[key] : Reflect.get(target, key),
  })
  return { client, hold, calls }
}
