import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { StudyMessage } from '../contract.ts'
import {
  commandLine,
  currentTutor,
  type KeyboardEventLike,
  MessageView,
  permissionAnswerOf,
  PermissionPrompt,
  visibleCommand,
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

test('a reflection row is drawn as a divider named 振り返り', () => {
  const html = render(message('reflection', ''))

  expect(html).toContain('role="separator"')
  expect(html).toContain('振り返り')
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
  ['allowed', '<code>docker ps &lt;b&gt; …（複数行）</code> を許した'],
  ['denied', '<code>docker ps &lt;b&gt; …（複数行）</code> を断った'],
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

test('the prompt shows a bidi control in the command visibly', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt permission={permission('pending', 'cat a\u202Eb')} onAnswer={() => {}} />,
  )

  expect(html).toContain('cat a\\u{202e}b</pre>')
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
  ['1 held down', { key: '1', repeat: true }, null],
])('the key %s answers the prompt with %p', (_name, event, answer) => {
  expect(permissionAnswerOf({ ...noKeys, ...event }, 500)).toBe(answer)
})

test('a key within 500ms of the prompt showing is not an answer, so a 1 typed into the input does not allow', () => {
  expect(permissionAnswerOf({ ...noKeys, key: '1' }, 499)).toBeNull()
  expect(permissionAnswerOf({ ...noKeys, key: '1' }, 500)).toBe(true)
})

test('bidi controls, zero-width characters, CR and other control characters in a command show as \\u{…}', () => {
  expect(visibleCommand('rm -rf /tmp/\u202Egnp.sh\u2066x\u200By\uFEFF\r\x07z\x7F')).toBe(
    'rm -rf /tmp/\\u{202e}gnp.sh\\u{2066}x\\u{200b}y\\u{feff}\\u{d}\\u{7}z\\u{7f}',
  )
  expect(visibleCommand('ls\n\t-la')).toBe('ls\n\t-la')
})

test('the history line of a command is its first line shown visibly, marked when more lines follow', () => {
  expect(commandLine('docker ps')).toBe('docker ps')
  expect(commandLine('echo a\u202E\necho b')).toBe('echo a\\u{202e} …（複数行）')
})

const noKeys: KeyboardEventLike = {
  key: '',
  repeat: false,
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
