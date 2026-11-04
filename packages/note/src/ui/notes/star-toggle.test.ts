import { expect, test } from 'bun:test'

import { createStarToggle } from './star-toggle.ts'

function fakeStore(initial: boolean) {
  let starred = initial
  const sends: boolean[] = []
  const waiting: (() => void)[] = []
  let held = false
  return {
    sends,
    hold: () => (held = true),
    release: () => {
      held = false
      for (const resume of waiting.splice(0)) resume()
    },
    set: (next: boolean) => (starred = next),
    deps: {
      read: () => Promise.resolve(starred),
      send: async (_id: string, next: boolean) => {
        sends.push(next)
        if (held) await new Promise<void>((resolve) => waiting.push(resolve))
        starred = next
      },
      invalidate: () => {},
    },
  }
}

test('続けて押すと、前の押下が届いてから次の値を決めるので、どちらの押下も反転として効く', async () => {
  const store = fakeStore(false)
  const toggle = createStarToggle(store.deps)
  store.hold()
  const first = toggle('note-1')
  const second = toggle('note-1')
  await Bun.sleep(0)
  store.release()
  await Promise.all([first, second])

  expect(store.sends).toEqual([true, false])
})

test('他の画面で変わった Star も、押した時に読み直して反転する', async () => {
  const store = fakeStore(false)
  const toggle = createStarToggle(store.deps)
  await toggle('note-1')
  store.set(false)
  await toggle('note-1')

  expect(store.sends).toEqual([true, true])
})

test('送れなかった押下の後も、次の押下は受け付ける', async () => {
  const store = fakeStore(false)
  let fail = true
  const toggle = createStarToggle({
    ...store.deps,
    send: (id, next) => (fail ? Promise.reject(new Error('offline')) : store.deps.send(id, next)),
  })
  await toggle('note-1')
  fail = false
  await toggle('note-1')

  expect(store.sends).toEqual([true])
})
