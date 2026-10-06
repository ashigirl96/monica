import { expect, test } from 'bun:test'

import type { Node as PMNode } from 'prosemirror-model'

import fullDoc from '../../body/fixtures/full-doc.json'
import { docFromJSON } from './create-editor.ts'

const topLevelIds = (doc: PMNode) => {
  const ids: unknown[] = []
  doc.child(0).forEach((container) => ids.push(container.attrs.id))
  return ids
}

test('the editor opens a saved body with every block in place', () => {
  const ids = fullDoc.content[0]!.content.map((container) => container.attrs.id)

  expect(topLevelIds(docFromJSON(fullDoc))).toEqual(ids)
})
