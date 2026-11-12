import { expect, test } from 'bun:test'

import {
  commandOf,
  createNoteKeys,
  type KeyFacts,
  type NoteCommand,
  type NoteKeyRow,
} from './keys.ts'

const facts = (init: Partial<KeyFacts>): KeyFacts => ({
  key: '',
  code: '',
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  composing: false,
  ...init,
})

test.each<[string, Parameters<typeof commandOf>[0], Partial<KeyFacts>, NoteCommand | undefined]>([
  ['⌥B', null, { alt: true, code: 'KeyB' }, 'toggleZen'],
  ['⌃2', null, { ctrl: true, code: 'Digit2' }, 'goEssays'],
  ['⌃4', null, { ctrl: true, code: 'Digit4' }, 'goRailItem'],
  ['⌥D', null, { alt: true, code: 'KeyD' }, 'toggleDensity'],
  ['; だけ', null, { code: 'Semicolon' }, undefined],
  ['⌥;', null, { alt: true, code: 'Semicolon' }, 'cycleAmbient'],
  ['⇧⌥;', null, { alt: true, shift: true, code: 'Semicolon' }, 'cycleAmbient'],
  ['⌘⌥;', null, { alt: true, meta: true, code: 'Semicolon' }, undefined],
  ['⌃⌥;', null, { alt: true, ctrl: true, code: 'Semicolon' }, undefined],
  ['⌘=', null, { meta: true, key: '=' }, 'zoomIn'],
  ['⇧⌘+', null, { meta: true, shift: true, key: '+' }, 'zoomIn'],
  ['JIS 配列の ⌘;', null, { meta: true, key: ';' }, 'zoomIn'],
  ['⌃=', null, { ctrl: true, key: '=' }, 'zoomIn'],
  ['⌘ テンキーの +', null, { meta: true, code: 'NumpadAdd' }, 'zoomIn'],
  ['⌘-', null, { meta: true, key: '-' }, 'zoomOut'],
  ['⌘0', null, { meta: true, key: '0' }, 'zoomReset'],
  ['⌘ を伴わない =', null, { key: '=' }, undefined],
  ['⌘⌥=', null, { meta: true, alt: true, key: '=' }, undefined],
  ['Daily の ⌥J', 'daily', { alt: true, code: 'KeyJ' }, 'next'],
  ['Essay の ⌥K', 'essays', { alt: true, code: 'KeyK' }, 'prev'],
  ['Essay の ⌥⌦', 'essays', { alt: true, code: 'Delete' }, 'remove'],
  ['Essay の ⌥L', 'essays', { alt: true, code: 'KeyL' }, 'switchEssayList'],
  ['Essay の ⌃W', 'essays', { ctrl: true, code: 'KeyW' }, 'toggleStatus'],
  ['Repo の ⌃W', 'repos', { ctrl: true, code: 'KeyW' }, 'openPicker'],
  ['Repo の ⇧⌃W', 'repos', { ctrl: true, shift: true, code: 'KeyW' }, undefined],
  ['⌃⌥1', null, { ctrl: true, alt: true, code: 'Digit1' }, undefined],
  ['Repo の ⌥⌫', 'repos', { alt: true, code: 'Backspace' }, 'remove'],
  ['Repo の ⌥H', 'repos', { alt: true, code: 'KeyH' }, undefined],
  ['Daily の ⌥N', 'daily', { alt: true, code: 'KeyN' }, undefined],
  ['区分の無い画面の ⌥N', null, { alt: true, code: 'KeyN' }, undefined],
  ['⌘⌥J', 'daily', { alt: true, meta: true, code: 'KeyJ' }, undefined],
  ['⌃⌥J', 'daily', { alt: true, ctrl: true, code: 'KeyJ' }, undefined],
  ['⇧⌥J', 'daily', { alt: true, shift: true, code: 'KeyJ' }, undefined],
])('%s は %p で %p を引く', (_, section, init, expected) => {
  expect(commandOf(section, facts(init))).toBe(expected)
})

const rows: NoteKeyRow[] = [
  { mods: 'alt', codes: ['KeyX'], command: 'toggleZen' },
  { mods: 'alt', codes: ['KeyX'], command: 'next', section: 'daily' },
  { mods: 'altAnyShift', codes: ['KeyY'], command: 'cycleAmbient', composing: true },
]

test('区分の行が全画面の行より先に当たる', () => {
  const keys = createNoteKeys(rows)
  const pressed: string[] = []
  keys.register(null, { toggleZen: () => pressed.push('toggleZen') })
  keys.register('daily', { next: () => pressed.push('next') })
  expect(keys.press(facts({ alt: true, code: 'KeyX' }))).toBe(true)
  expect(pressed).toEqual(['next'])
})

test('処理の無い命令のキーは取らない', () => {
  const keys = createNoteKeys(rows)
  expect(keys.press(facts({ alt: true, code: 'KeyY' }))).toBe(false)
  const off = keys.register(null, { cycleAmbient: () => {} })
  expect(keys.press(facts({ alt: true, code: 'KeyY' }))).toBe(true)
  off()
  expect(keys.press(facts({ alt: true, code: 'KeyY' }))).toBe(false)
})

test('処理が false を返したらキーを取らない', () => {
  const keys = createNoteKeys(rows)
  keys.register('daily', { next: () => false })
  expect(keys.press(facts({ alt: true, code: 'KeyX' }))).toBe(false)
})

test('IME の変換中は取らず、変換中も取る印のある行だけを取る', () => {
  const keys = createNoteKeys(rows)
  keys.register(null, { toggleZen: () => {}, cycleAmbient: () => {} })
  expect(keys.press(facts({ alt: true, code: 'KeyX', composing: true }))).toBe(false)
  expect(keys.press(facts({ alt: true, code: 'KeyY', composing: true }))).toBe(true)
})

test('表の ⌥; と ⌘= は変換中でも取り、⌥B は変換中は取らない', () => {
  const keys = createNoteKeys()
  keys.register(null, { cycleAmbient: () => {}, toggleZen: () => {}, zoomIn: () => {} })
  expect(keys.press(facts({ meta: true, key: '=', composing: true }))).toBe(true)
  expect(keys.press(facts({ alt: true, code: 'Semicolon', composing: true }))).toBe(true)
  expect(keys.press(facts({ alt: true, code: 'KeyB', composing: true }))).toBe(false)
})

test('処理には押したキーの事実を渡す', () => {
  const keys = createNoteKeys(rows)
  let shift: boolean | undefined
  keys.register(null, { cycleAmbient: (k) => void (shift = k.shift) })
  keys.press(facts({ alt: true, code: 'KeyY', shift: true }))
  expect(shift).toBe(true)
})
