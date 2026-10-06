import { expect, test } from 'bun:test'

import fullDoc from './fixtures/full-doc.json'
import unknownNodes from './fixtures/unknown-nodes.json'
import { EMPTY_DOC, preview } from './index.ts'

const doc = (...containers: unknown[]) => ({
  type: 'doc',
  content: [{ type: 'blockGroup', content: containers }],
})
const line = (text: string) => ({
  type: 'blockContainer',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

test('the preview is the text of the first block, without its mentions and hard breaks', () => {
  expect(preview(fullDoc)).toBe('plain styled under gone mono linked')
})

test('the preview keeps the text inside an inline node the server does not know', () => {
  expect(preview(unknownNodes)).toBe('known inline-unknown marked')
})

const fullDocContainers = new Map(
  fullDoc.content[0]!.content.map((container) => [container.attrs.id, container]),
)

test.each([
  ['b2', 'Heading'],
  ['b3', 'item'],
  ['b4', 'first'],
  ['b5', 'hidden'],
  ['b6', 'quoted'],
  ['b7', 'careful'],
  ['b8', 'fn main() {}'],
  ['b9', null],
  ['b10', null],
  ['b11', null],
  ['b12', null],
  ['b13', 'Col A Col B a1 b1 | piped'],
])('the block %s of the full doc alone previews as %p', (id, expected) => {
  expect(preview(doc(fullDocContainers.get(id)))).toBe(expected)
})

test('a block with no text is passed over for its nested blocks, then for the next block', () => {
  const blank = { type: 'blockContainer', content: [{ type: 'paragraph' }] }
  const parent = {
    type: 'blockContainer',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '   ' }] },
      { type: 'blockGroup', content: [blank, line('  nested  ')] },
    ],
  }

  expect(preview(doc(blank, parent, line('next')))).toBe('nested')
  expect(preview(doc(blank, fullDocContainers.get('b9'), line('next')))).toBe('next')
})

test('the preview is cut at 200 characters, counting an emoji joined from several as one', () => {
  const family = '👨‍👩‍👧'

  expect(preview(doc(line(family.repeat(250))))).toBe(family.repeat(200))
})

test('an empty doc has no preview', () => {
  expect(preview(EMPTY_DOC)).toBeNull()
})
