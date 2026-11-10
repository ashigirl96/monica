import { afterEach, expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { closePage, FakeStorage, openPage } from '../fake-browser.ts'
import type { RailItem } from '../slots.ts'
import { AppShell } from './app-shell.tsx'

afterEach(closePage)

const dummy: RailItem = { to: '/dummy', label: 'Dummy', icon: <svg /> }

function render(props: { railItem?: RailItem; onSlotPage: boolean }) {
  openPage(new FakeStorage())
  return renderToStaticMarkup(
    <AppShell active={props.onSlotPage ? null : 'daily'} {...props}>
      <p>page</p>
    </AppShell>,
  )
}

const dummyLink = (html: string) => html.match(/<a [^>]*aria-label="Dummy"[^>]*>/)?.[0]

const railLabels = (html: string) =>
  [...html.matchAll(/<(?:a|button) [^>]*aria-label="([^"]+)"/g)].map((m) => m[1])

test('the rail item sits after Repo and before the theme toggle', () => {
  const labels = railLabels(render({ railItem: dummy, onSlotPage: false }))

  expect(labels.slice(0, 4)).toEqual(['Daily', 'Essay', 'Repo', 'Dummy'])
  expect(labels[4]).toStartWith('Theme:')
})

test('on the page of the slot, the rail item is current and the pills are gone', () => {
  const html = render({ railItem: dummy, onSlotPage: true })

  expect(dummyLink(html)).toContain('aria-current="page"')
  expect(dummyLink(html)).toContain('href="/dummy"')
  expect(html).not.toContain('Ambient:')
  expect(html).not.toContain('Editor width')
})

test('on a page of note, the rail item is not current and the pills stay', () => {
  const html = render({ railItem: dummy, onSlotPage: false })

  expect(dummyLink(html)).toBeDefined()
  expect(dummyLink(html)).not.toContain('aria-current')
  expect(html).toContain('Ambient:')
  expect(html).toContain('Editor width')
})

test('without a rail item, the rail links are Daily, Essay and Repo', () => {
  const html = render({ onSlotPage: false })

  expect([...html.matchAll(/<a [^>]*aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual([
    'Daily',
    'Essay',
    'Repo',
  ])
})
