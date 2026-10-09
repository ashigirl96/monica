import { describe, expect, test } from 'bun:test'

import type { Node as PMNode } from 'prosemirror-model'

import fullDoc from '../../body/fixtures/full-doc.json'
import unknownNodes from '../../body/fixtures/unknown-nodes.json'
import { EMPTY_DOC } from '../../body/index.ts'
import { docFromJSON } from './create-editor.ts'
import { readDoc } from './test-fixtures.ts'

const topLevelIds = (doc: PMNode) => {
  const ids: unknown[] = []
  doc.child(0).forEach((container) => ids.push(container.attrs.id))
  return ids
}

test('the editor opens a saved body with every block in place', () => {
  const ids = fullDoc.content[0]!.content.map((container) => container.attrs.id)

  expect(topLevelIds(readDoc(fullDoc))).toEqual(ids)
})

test('the editor opens the body of a new note', () => {
  const doc = readDoc(EMPTY_DOC)

  expect(doc.child(0).childCount).toBe(EMPTY_DOC.content[0]!.content.length)
  expect(doc.textContent).toBe('')
})

test('a note without a body opens as an empty doc', () => {
  expect(readDoc(null).childCount).toBe(1)
  expect(readDoc(undefined).childCount).toBe(1)
})

describe('a body the editor cannot read', () => {
  const withEmptyGroup = {
    ...fullDoc,
    content: [
      {
        ...fullDoc.content[0]!,
        content: [
          ...fullDoc.content[0]!.content,
          {
            type: 'blockContainer',
            attrs: { id: 'empty-group' },
            content: [{ type: 'paragraph' }, { type: 'blockGroup', content: [] }],
          },
        ],
      },
    ],
  }

  test.each([
    ['nodes and marks outside the schema', unknownNodes],
    ['a blockGroup without children', withEmptyGroup],
  ])('fails with the reason when it has %s', (_, json) => {
    const read = docFromJSON(json)

    expect(read).toEqual({ ok: false, error: expect.stringMatching(/\S/) })
  })
})
