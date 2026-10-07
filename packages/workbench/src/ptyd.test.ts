import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'

import { startFakePtyd, tempHome } from './fake-ptyd.ts'
import { openDaemon } from './ptyd.ts'
import { cleanUp, onCleanup } from './testing.ts'

afterEach(cleanUp)

test('a cwd whose multibyte character straddles two socket chunks is read intact', async () => {
  const home = tempHome(onCleanup)
  const ptyd = startFakePtyd(home)
  onCleanup(() => ptyd.stop())
  ptyd.sessions.push({
    session_id: 'ts-a',
    running: true,
    attached: false,
    pid: 4242,
    exit_code: null,
    cwd: '/work/日本語',
    rows: 24,
    cols: 80,
  })
  ptyd.splitListMidCharacter = true
  const opened = await openDaemon(
    { home, ptydPath: join(home, 'no-ptyd') },
    { onExit: () => {}, onClose: () => {} },
  )
  onCleanup(() => opened.close())

  expect((await opened.list()).map((s) => s.cwd)).toEqual(['/work/日本語'])
})
