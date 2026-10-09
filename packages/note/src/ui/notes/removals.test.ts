import { expect, mock, test } from 'bun:test'

import { ORPCError } from '@orpc/client'

import type { Note } from '../../contract.ts'
import { isNotFound, type RemovableKind, Removals } from './removals.ts'

const at = new Date(2026, 9, 6, 12)

function note(kind: RemovableKind, id: string): Note {
  const fields = { id, title: '', date: '2026-10-06', content: { type: 'doc' as const } }
  return kind === 'essay'
    ? { kind, ...fields, status: 'writing', createdAt: at, updatedAt: at }
    : { kind, ...fields, repo: 'acme/app', createdAt: at, updatedAt: at }
}

/** `open` は画面が開いている Note。URL とエディタの `noteRef` がそれを指す。 */
function setup(kind: RemovableKind, open: Note | null = null) {
  const unsaved = new Set<string>()
  let url = open?.id ?? null
  const deps = {
    flush: mock(() => Promise.resolve()),
    hasUnsaved: (id: string) => unsaved.has(id),
    remove: mock((_id: string) => Promise.resolve()),
    restore: mock((id: string) => Promise.resolve(note(kind, id))),
    discard: mock((_id: string) => {}),
    forgetBody: mock((_id: string) => {}),
    openId: () => url,
  }
  const editor = { noteRef: { current: open }, reschedule: mock((_note: Note) => {}) }
  return {
    removals: new Removals(kind, deps),
    deps,
    unsaved,
    editor,
    leave: mock(() => {}),
    /** URL だけを移す。`noteRef` が追いつくのは描画の後。 */
    browse: (id: string | null) => {
      url = id
    },
  }
}

test('removing drops the saves still waiting and the cached body, and undo brings the Notes back last first', async () => {
  const { removals, deps, leave } = setup('essay')

  expect(await removals.remove('note-1', { leave })).toBe(true)
  expect(await removals.remove('note-2', { leave })).toBe(true)

  expect(deps.discard.mock.calls).toEqual([['note-1'], ['note-2']])
  expect(deps.forgetBody.mock.calls).toEqual([['note-1'], ['note-2']])
  expect((await removals.undo())?.id).toBe('note-2')
  expect((await removals.undo())?.id).toBe('note-1')
  expect(await removals.undo()).toBeNull()
})

test('removing waits for the pending edits to be saved before it removes the Note', async () => {
  const { removals, deps, unsaved, leave } = setup('essay')
  unsaved.add('note-1')
  const flushed = Promise.withResolvers<void>()
  deps.flush.mockImplementationOnce(() => flushed.promise)

  const removing = removals.remove('note-1', { leave })
  await Bun.sleep(0)
  expect(deps.remove).not.toHaveBeenCalled()
  unsaved.delete('note-1')
  flushed.resolve()

  expect(await removing).toBe(true)
  expect(deps.remove.mock.calls).toEqual([['note-1']])
})

test('edits typed into the Note while the Backend removes it bring the Note back, so they are saved to it', async () => {
  const { removals, deps, unsaved, leave, browse } = setup('essay')
  deps.remove.mockImplementationOnce(() => {
    browse('note-1')
    unsaved.add('note-1')
    return Promise.resolve()
  })

  expect(await removals.remove('note-1', { leave })).toBe(false)

  expect(deps.restore.mock.calls).toEqual([['note-1']])
  expect(deps.discard).not.toHaveBeenCalled()
  expect(deps.forgetBody).not.toHaveBeenCalled()
  expect(leave).not.toHaveBeenCalled()
  expect(await removals.undo()).toBeNull()
})

test('a Note that cannot be brought back for the edits typed while removing it stays removed, and undo tries again', async () => {
  const { removals, deps, unsaved, leave } = setup('essay')
  deps.remove.mockImplementationOnce(() => {
    unsaved.add('note-1')
    return Promise.resolve()
  })
  deps.restore.mockImplementationOnce(() => Promise.reject(new Error('unreachable')))

  expect(await removals.remove('note-1', { leave })).toBe(true)

  expect(deps.discard.mock.calls).toEqual([['note-1']])
  expect((await removals.undo())?.id).toBe('note-1')
})

/** 保存し切れずに未保存が残るか、Backend が削除を断る。 */
const refusals = [
  ['an edit left unsaved', (s: ReturnType<typeof setup>) => s.unsaved.add('note-1')],
  [
    'the Backend refusing',
    (s: ReturnType<typeof setup>) =>
      s.deps.remove.mockImplementationOnce(() => Promise.reject(new Error('unreachable'))),
  ],
] as const

test('a removal that does not go through leaves nothing to undo and stays on the Note', async () => {
  for (const [why, refuse] of refusals) {
    const s = setup('repo_note', note('repo_note', 'note-1'))
    refuse(s)

    expect(await s.removals.remove('note-1', { editor: s.editor, leave: s.leave }), why).toBe(false)

    expect(s.deps.discard, why).not.toHaveBeenCalled()
    expect(s.deps.forgetBody, why).not.toHaveBeenCalled()
    expect(s.leave, why).not.toHaveBeenCalled()
    expect(await s.removals.undo(), why).toBeNull()
  }
})

test('nothing is saved to the open Note while it is being removed, and when the removal does not go through its edits are saved again', async () => {
  for (const [why, refuse] of refusals) {
    const open = note('essay', 'note-1')
    const s = setup('essay', open)
    refuse(s)
    const savedTo: (Note | null)[] = []
    s.deps.flush.mockImplementationOnce(() => {
      savedTo.push(s.editor.noteRef.current)
      return Promise.resolve()
    })

    expect(await s.removals.remove('note-1', { editor: s.editor, leave: s.leave }), why).toBe(false)

    expect(savedTo, why).toEqual([null])
    expect(s.editor.noteRef.current, why).toBe(open)
    expect(s.editor.reschedule.mock.calls, why).toEqual([[open]])
  }
})

test('a Note taken up while the removal fails keeps the edits typed into it', async () => {
  const { removals, deps, editor, leave, browse } = setup('repo_note', note('repo_note', 'note-1'))
  const other = note('repo_note', 'note-2')
  deps.remove.mockImplementationOnce(() => {
    browse('note-2')
    editor.noteRef.current = other
    return Promise.reject(new Error('unreachable'))
  })

  expect(await removals.remove('note-1', { editor, leave })).toBe(false)

  expect(editor.noteRef.current).toBe(other)
  expect(editor.reschedule).not.toHaveBeenCalled()
})

test('a newer version of the Note taken up while the removal fails is not replaced by the one being removed', async () => {
  const { removals, deps, editor, leave } = setup('essay', note('essay', 'note-1'))
  const newer = { ...note('essay', 'note-1'), title: 'Retitled elsewhere' }
  deps.remove.mockImplementationOnce(() => {
    editor.noteRef.current = newer
    return Promise.reject(new Error('unreachable'))
  })

  expect(await removals.remove('note-1', { editor, leave })).toBe(false)

  expect(editor.noteRef.current).toBe(newer)
  expect(editor.reschedule).not.toHaveBeenCalled()
})

test('a removed Note that was open is not saved to again, and the screen leaves it', async () => {
  const { removals, editor, leave } = setup('essay', note('essay', 'note-1'))

  expect(await removals.remove('note-1', { editor, leave })).toBe(true)

  expect(editor.noteRef.current).toBeNull()
  expect(editor.reschedule).not.toHaveBeenCalled()
  expect(leave).toHaveBeenCalledTimes(1)
})

test('the screen leaves a removed Note only when the URL points at it once the removal is done', async () => {
  for (const [from, to, leaves] of [
    ['note-9', 'note-1', true],
    ['note-1', 'note-2', false],
    ['note-9', 'note-9', false],
  ] as const) {
    const { removals, deps, editor, leave, browse } = setup('repo_note', note('repo_note', from))
    deps.remove.mockImplementationOnce(() => {
      browse(to)
      return Promise.resolve()
    })

    expect(await removals.remove('note-1', { editor, leave })).toBe(true)

    expect(leave.mock.calls.length, `${from} → ${to}`).toBe(leaves ? 1 : 0)
  }
})

test('an undo that fails goes back where it was, so the next undo tries it again after the Notes removed meanwhile', async () => {
  const { removals, deps, leave } = setup('essay')
  await removals.remove('note-1', { leave })
  await removals.remove('note-2', { leave })
  const restoring = Promise.withResolvers<Note>()
  deps.restore.mockImplementationOnce(() => restoring.promise)

  const failed = removals.undo()
  await removals.remove('note-3', { leave })
  restoring.reject(new Error('unreachable'))

  expect(await failed).toBeNull()
  expect((await removals.undo())?.id).toBe('note-3')
  expect((await removals.undo())?.id).toBe('note-2')
  expect((await removals.undo())?.id).toBe('note-1')
})

test('a removal that fails after the screen moved to another Note does not open the Note again before the move is drawn', async () => {
  const { removals, deps, unsaved, editor, leave, browse } = setup(
    'repo_note',
    note('repo_note', 'note-1'),
  )
  unsaved.add('note-1')
  deps.flush.mockImplementationOnce(() => {
    browse('note-2')
    return Promise.resolve()
  })

  expect(await removals.remove('note-1', { editor, leave })).toBe(false)

  expect(editor.noteRef.current).toBeNull()
  expect(editor.reschedule).not.toHaveBeenCalled()
})

test('an open Note of a kind the screen does not remove is left alone', async () => {
  for (const [screen, other] of [
    ['essay', 'repo_note'],
    ['repo_note', 'essay'],
  ] as const) {
    const open = note(other, 'note-1')
    const { removals, deps, editor, leave } = setup(screen, open)

    expect(await removals.remove('note-1', { editor, leave })).toBe(false)

    expect(deps.flush).not.toHaveBeenCalled()
    expect(deps.remove).not.toHaveBeenCalled()
    expect(editor.noteRef.current).toBe(open)
  }
})

test('a Note removed elsewhere drops its saves and cached body, is not saved to again, and the screen leaves it', () => {
  const { removals, deps, editor, leave } = setup('essay', note('essay', 'note-1'))

  removals.removedElsewhere('note-1', { editor, leave })

  expect(deps.discard.mock.calls).toEqual([['note-1']])
  expect(deps.forgetBody.mock.calls).toEqual([['note-1']])
  expect(editor.noteRef.current).toBeNull()
  expect(leave).toHaveBeenCalledTimes(1)
  expect(deps.remove).not.toHaveBeenCalled()
})

test('a Note removed elsewhere is not pushed on the undo stack', async () => {
  const { removals, deps, editor, leave } = setup('repo_note', note('repo_note', 'note-1'))
  await removals.remove('note-0', { leave })

  removals.removedElsewhere('note-1', { editor, leave })

  expect((await removals.undo())?.id).toBe('note-0')
  expect(await removals.undo()).toBeNull()
  expect(deps.restore.mock.calls).toEqual([['note-0']])
})

test('the screen leaves a Note removed elsewhere only while the URL and the editor still point at it', () => {
  const { removals, deps, editor, leave, browse } = setup('essay', note('essay', 'note-1'))
  const other = note('essay', 'note-2')
  browse('note-2')
  editor.noteRef.current = other

  removals.removedElsewhere('note-1', { editor, leave })

  expect(deps.discard.mock.calls).toEqual([['note-1']])
  expect(editor.noteRef.current).toBe(other)
  expect(leave).not.toHaveBeenCalled()
})

test('only a NOT_FOUND answer from the Backend means the Note was removed', () => {
  expect(isNotFound(new ORPCError('NOT_FOUND'))).toBe(true)
  expect(isNotFound(new ORPCError('INTERNAL_SERVER_ERROR'))).toBe(false)
  expect(isNotFound(new Error('NOT_FOUND'))).toBe(false)
  expect(isNotFound(null)).toBe(false)
})
