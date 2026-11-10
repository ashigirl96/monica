import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { StudyMessage } from '../contract.ts'
import {
  currentTutor,
  type KeyboardEventLike,
  MessageView,
  permissionAnswerOf,
  PermissionPrompt,
} from './messages.tsx'

const DIR = '/home/u/.monica/studies/study-1'

const message = (
  kind: StudyMessage['kind'],
  text: string,
  tool: string | null = null,
): StudyMessage => ({
  id: 1,
  conversationId: 'conversation-1',
  kind,
  text,
  tool,
  reason: null,
  state: null,
  createdAt: new Date('2026-11-11T00:00:00Z'),
})

const permission = (
  state: 'pending' | 'allowed' | 'denied',
  text = 'docker ps <b>\n--all',
  reason: string | null = 'List <i>containers</i>',
): StudyMessage => ({ ...message('permission', text), reason, state })

const render = (m: StudyMessage) => renderToStaticMarkup(<MessageView message={m} dir={DIR} />)

test('what the user said stays text, not HTML or markdown', () => {
  const html = render(message('user', '<b>bold</b> **not bold**'))

  expect(html).not.toContain('<b>')
  expect(html).toContain('&lt;b&gt;bold&lt;/b&gt; **not bold**')
})

test('the Tutor text is markdown without HTML or images', () => {
  const html = render(message('tutor', '**why** ky? <img src=x onerror=alert(1)>'))

  expect(html).toContain('<strong>why</strong>')
  expect(html).not.toContain('<img')
})

test('an https link of the Tutor opens in a new Browser Tab, and a relative or javascript link shows as text', () => {
  const html = render(
    message('tutor', '[docs](https://example.com/a) [x](MISSION.md) [y](javascript:alert(1))'),
  )

  expect(html).toContain(
    '<a href="https://example.com/a" target="_blank" rel="noreferrer">docs</a>',
  )
  expect(html.match(/<a /g)).toHaveLength(1)
  expect(html).toContain('x')
  expect(html).toContain('y')
})

test.each<[string, string, string]>([
  ['Read', `${DIR}/notes/hooks.md`, 'notes/hooks.md を読んだ'],
  ['WebFetch', 'https://example.com/a', 'https://example.com/a を読んだ'],
  ['Write', `${DIR}/MISSION.md`, 'MISSION.md を書いた'],
  ['Edit', '/etc/hosts', '/etc/hosts を書いた'],
  ['Bash', 'bun test', '<code>bun test</code> を走らせた'],
  ['WebSearch', 'ky hooks', 'ky hooks を探した'],
  ['Glob', '**/*.ts', '**/*.ts を探した'],
  ['Grep', 'beforeRequest', 'beforeRequest を探した'],
  ['Skill', 'tutors:repository', 'Skill を使った'],
])('a %s row reads as one line', (tool, text, line) => {
  const html = render(message('tool', text, tool))
  expect(html).toContain(line)
  expect(html).not.toContain(DIR)
})

test('a tutor_switch row reads that the Tutor changed', () => {
  expect(render(message('tutor_switch', 'repository'))).toContain('Tutor を repository に替えた')
})

test.each<['allowed' | 'denied', string]>([
  ['allowed', '<code>docker ps &lt;b&gt;</code> を許した'],
  ['denied', '<code>docker ps &lt;b&gt;</code> を断った'],
])(
  'an %s permission row reads as one line with the first line of the command as text',
  (state, line) => {
    const html = render(permission(state))

    expect(html).toContain(line)
    expect(html).not.toContain('--all')
  },
)

test('the prompt shows the whole command and the reason as text, not HTML', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt permission={permission('pending')} onAnswer={() => {}} />,
  )

  expect(html).toContain('箱の外で走らせてよいか')
  expect(html).toContain('docker ps &lt;b&gt;\n--all</pre>')
  expect(html).toContain('List &lt;i&gt;containers&lt;/i&gt;')
  expect(html).toContain('許す（この 1 回だけ）')
  expect(html).toContain('断る')
})

test('the prompt without a reason says that none was given', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt permission={permission('pending', 'ls', null)} onAnswer={() => {}} />,
  )

  expect(html).toContain('理由は書かれていない')
})

test.each<[string, Partial<KeyboardEventLike>, boolean | null]>([
  ['1', { key: '1' }, true],
  ['2', { key: '2' }, false],
  ['3', { key: '3' }, null],
  ['⌘1', { key: '1', metaKey: true }, null],
  ['⌃2', { key: '2', ctrlKey: true }, null],
  ['⌥1', { key: '1', altKey: true }, null],
  ['⇧1', { key: '1', shiftKey: true }, null],
  ['1 while composing', { key: '1', isComposing: true }, null],
])('the key %s answers the prompt with %p', (_name, event, answer) => {
  expect(permissionAnswerOf({ ...noKeys, ...event })).toBe(answer)
})

const noKeys: KeyboardEventLike = {
  key: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
}

test('the current Tutor is the last switch of the conversation, or the shared way of teaching without one', () => {
  expect(currentTutor([message('user', 'hi')])).toBe('共通の教え方')
  expect(
    currentTutor([
      message('tutor_switch', 'repository'),
      message('tutor', 'ok'),
      message('tutor_switch', 'paper'),
    ]),
  ).toBe('paper')
})
