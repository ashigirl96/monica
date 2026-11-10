import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { StudyClient } from './client.ts'
import { createStudySlots } from './slots.tsx'

// 描くだけで effect も query の取得も走らないので、client は呼ばれない。
const { slotPage, railItem } = createStudySlots({
  client: {} as StudyClient,
  navigate: () => {},
  spaLinkClick: () => () => {},
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
