import { afterAll, beforeAll, expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { StudyClient } from './client.ts'
import { createStudySlots } from './slots.tsx'

// 描くだけで effect も query の取得も走らないので、client は呼ばれない。
const { slotPage, railItem, repoPanel } = createStudySlots({
  client: {} as StudyClient,
  repoCandidates: async () => [],
  navigate: () => {},
  spaLinkClick: () => () => {},
})

// 会話欄の幅のピルと左右の欄が、描くときに残した幅・窓幅・拡大率を読む。
beforeAll(() => {
  Object.assign(globalThis, {
    localStorage: { getItem: () => null },
    window: { innerWidth: 1440, addEventListener() {}, removeEventListener() {} },
    document: { documentElement: { style: { getPropertyValue: () => '' } } },
  })
})
afterAll(() => {
  Reflect.deleteProperty(globalThis, 'localStorage')
  Reflect.deleteProperty(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'document')
})

const render = (pathname: string) => {
  const page = slotPage(pathname)
  return page && renderToStaticMarkup(page)
}

test('/studies is the new conversation, and /studies/<id> is the Study', () => {
  expect(render('/studies')).toContain('新しい会話')
  const study = render('/studies/study-0190a000-0000-7000-8000-000000000001')
  expect(study).toContain('aria-label="新しい会話（⌥N）"')
  expect(study).not.toContain('その Study は無い')
})

test('any other path under /studies has no Study', () => {
  expect(render('/studies/')).toContain('その Study は無い')
  expect(render('/studies/abc')).toContain('その Study は無い')
  expect(render('/studies/study-0190a000-0000-7000-8000-000000000001/x')).toContain(
    'その Study は無い',
  )
})

test('a path outside /studies is not drawn', () => {
  expect(slotPage('/study')).toBeNull()
  expect(slotPage('/studiesx')).toBeNull()
  expect(slotPage('/dummy')).toBeNull()
})

test('the rail item goes to /studies', () => {
  expect(railItem).toMatchObject({ to: '/studies', label: 'Study' })
})

test('the Repo panel draws nothing while the Studies of the Repo are loading', () => {
  expect(renderToStaticMarkup(<>{repoPanel('acme/alpha')}</>)).toBe('')
})
