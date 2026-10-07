import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { closePage, FakeStorage, openPage } from './fake-browser.ts'
import { setThemePref, type ThemePref } from './theme.ts'

const indexHtml = readFileSync(join(import.meta.dir, '../../../../apps/web/index.html'), 'utf8')
const bootScript = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)![1]!

function themeOnReload(storage: FakeStorage, systemDark: boolean): string | undefined {
  const root = openPage(storage, { systemDark })
  // oxlint-disable-next-line typescript/no-implied-eval -- index.html の inline script を、ブラウザと同じ globals で走らせるため。
  new Function(bootScript)()
  return root.dataset.theme
}

afterEach(closePage)

test.each<[ThemePref, ThemePref, boolean, string]>([
  ['system', 'light', true, 'light'],
  ['light', 'dark', false, 'dark'],
  ['dark', 'system', true, 'dark'],
  ['light', 'system', true, 'dark'],
  ['dark', 'system', false, 'light'],
])(
  '%s から %s に切り替えると、OS が dark=%p の reload は最初の描画から %s',
  (before, after, systemDark, expected) => {
    const storage = new FakeStorage()
    const root = openPage(storage, { systemDark })
    setThemePref(before)
    setThemePref(after)
    expect(root.dataset.theme).toBe(expected)

    expect(themeOnReload(storage, systemDark)).toBe(expected)
  },
)

test('選んだテーマは localStorage の tania-theme に残る', () => {
  const storage = new FakeStorage()
  openPage(storage)
  setThemePref('light')
  expect([...storage.items]).toEqual([['tania-theme', 'light']])
})
