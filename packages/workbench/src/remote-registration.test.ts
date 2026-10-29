import { afterEach, expect, test } from 'bun:test'

import { remoteDevice } from './schema.ts'
import { cleanUp, setup } from './testing.ts'

afterEach(cleanUp)

// Synthetic test address, never taken from the user's interface.
const syntheticTailnetAddress = [100, 64, 0, 1].join('.')

test('remote access starts disabled and rejects non-Tailscale bind addresses without changing the layout', async () => {
  const { client, db } = setup()
  const layout = await client.layout.get()
  expect(await client.remote.status()).toMatchObject({
    state: 'disabled',
    devices: [],
    pending: null,
  })
  for (const address of [
    '0.0.0.0',
    '127.0.0.1',
    [192, 168, 1, 2].join('.'),
    '::',
    '::1',
    'example.com',
  ]) {
    await expect(client.remote.enable({ address, port: 19443 })).rejects.toThrow()
  }
  expect(await client.layout.get()).toEqual(layout)
  expect(db.select().from(remoteDevice).all()).toEqual([])
})

test('a failed Tailscale bind reports remote unavailable and leaves local Workbench operations usable', async () => {
  const { client } = setup()
  await client.remote.enable({ address: syntheticTailnetAddress, port: 19443 })
  expect(await client.remote.status()).toMatchObject({
    state: 'unavailable',
    error: expect.stringContaining('no fallback'),
  })
  await client.runspace.create({ rows: 24, cols: 80 })
  expect((await client.layout.get()).runspaces).toHaveLength(1)
  await expect(client.remote.invite()).rejects.toThrow()
  await client.remote.disable()
  expect((await client.remote.status()).state).toBe('disabled')
})
