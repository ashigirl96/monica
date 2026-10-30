import { expect, test } from 'claude-code/testing'

import { cells, fit, wrap } from './wrap'

const text =
  '英語の task は、誰かに割り当てられた、終わりのある 1 つの仕事を指す。job（繰り返す処理や職）や work item・ticket と違い、「やること」そのものを指す。'

test('Japanese breaks between characters, never past the width', () => {
  const lines = wrap(text, 20)
  expect(lines.length).toBeGreaterThan(1)
  for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(20)
  expect(lines.join('').replace(/ /g, '')).toBe(text.replace(/ /g, ''))
})

test('no line starts with closing punctuation, and an ASCII word stays whole', () => {
  for (const width of [12, 15, 18, 21, 24, 30]) {
    const lines = wrap(text, width)
    for (const line of lines) expect(line).not.toMatch(/^[、。）」]/)
    expect(lines.some((l) => l.includes('item'))).toBe(true)
  }
})

test('fit cuts at the width with an ellipsis', () => {
  expect(fit('タスク（作業）', 8)).toBe('タスク…')
  expect(fit('Run', 8)).toBe('Run')
})
