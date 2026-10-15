import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'

import { cleanUp, monicaHome, openTabOutsideBench, serveBackend } from './testing.ts'

afterEach(cleanUp)

test('task current run in a Tab takes the calling Terminal Session from MONICA_TERMINAL_SESSION_ID', async () => {
  const home = monicaHome()
  const { client } = serveBackend(home)
  const terminalSessionId = await openTabOutsideBench(client)

  const child = Bun.spawn(['bun', join(import.meta.dir, 'main.ts'), 'task', 'current'], {
    env: {
      PATH: process.env.PATH!,
      MONICA_HOME: home,
      MONICA_TERMINAL_SESSION_ID: terminalSessionId,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = await new Response(child.stderr).text()

  expect(await child.exited).toBe(1)
  expect(stderr).toStartWith(
    `NOT_FOUND: Terminal Session ${terminalSessionId} runs no Run of a Task`,
  )
})
