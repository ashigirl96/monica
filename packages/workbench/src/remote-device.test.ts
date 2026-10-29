import { afterEach, expect, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import { remoteDevice } from './schema.ts'
import { cleanUp, setup } from './testing.ts'

afterEach(cleanUp)

test('registered devices retain their source and revocation without changing the layout', async () => {
  const { db, client, restartBackend } = setup()
  await client.runspace.create({ cwd: '/work', rows: 24, cols: 80 })
  const before = await client.layout.get()
  db.insert(remoteDevice)
    .values({
      id: 'device-1',
      name: 'iPhone',
      secretHash: 'a'.repeat(64),
      sourceAddress: '192.0.2.2',
      revokedAt: null,
    })
    .run()
  db.update(remoteDevice)
    .set({ revokedAt: new Date(1234) })
    .where(eq(remoteDevice.id, 'device-1'))
    .run()
  const restarted = restartBackend()
  expect(db.select().from(remoteDevice).all()).toEqual([
    {
      id: 'device-1',
      name: 'iPhone',
      secretHash: 'a'.repeat(64),
      sourceAddress: '192.0.2.2',
      revokedAt: new Date(1234),
    },
  ])
  expect(await restarted.client.layout.get()).toEqual(before)
})
