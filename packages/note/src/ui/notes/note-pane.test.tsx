import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { Doc, Note } from '../../contract.ts'
import { NotePane } from './note-pane.tsx'
import { emptyView, type OpenNoteView } from './open-note.ts'

const unreadable = {
  id: 'n1',
  kind: 'pad',
  content: { type: 'doc', content: [{ type: 'no-such-node' }] } as unknown as Doc,
} as Note

function render(view: OpenNoteView) {
  return renderToStaticMarkup(
    <NotePane
      view={view}
      changeBody={() => {}}
      reload={async () => {}}
      autoFocus
      handleRef={{ current: null }}
      renderHeader={({ note, readOnly }) => <h1>{`${note.id} ${readOnly}`}</h1>}
    />,
  )
}

test('the error shows only while no Note is drawn, so a failed refetch keeps the body', () => {
  const error = new Error('offline')

  expect(render({ ...emptyView('n1', 0), error })).toContain('offline')
  const kept = render({ ...emptyView('n1', 0), note: unreadable, error })
  expect(kept).not.toContain('offline')
  expect(kept).toContain('<h1>n1 true</h1>')
})

test('a body the editor cannot read is shown read-only after the header and its notice', () => {
  const html = render({ ...emptyView('n1', 0), note: unreadable })

  const header = html.indexOf('<header class="pt-12"><h1>n1 true</h1><p role="alert"')
  expect(header).toBeGreaterThan(-1)
  expect(html.indexOf('<pre', header)).toBeGreaterThan(header)
})
