import { expect, mock, test } from 'bun:test'

import type { Note } from '../../contract.ts'
import { Removals } from './removals.ts'

const at = new Date(2026, 9, 6, 12)

function repoNote(id: string): Note {
  return {
    kind: 'repo_note',
    id,
    repo: 'acme/app',
    title: '',
    date: '2026-10-06',
    content: { type: 'doc' },
    createdAt: at,
    updatedAt: at,
  }
}

function setup() {
  const unsaved = new Set<string>()
  const deps = {
    flush: mock(() => Promise.resolve()),
    hasUnsaved: (id: string) => unsaved.has(id),
    remove: mock((_id: string) => Promise.resolve()),
    restore: mock((id: string) => Promise.resolve(repoNote(id))),
    discard: mock((_id: string) => {}),
    resume: mock((_id: string) => {}),
  }
  return { removals: new Removals(deps), deps, unsaved }
}

function editorOn(note: Note | null) {
  return { noteRef: { current: note }, reschedule: mock((_note: Note) => {}) }
}

test('removing saves the edits first, drops the saves still waiting, and undo brings the Notes back last first', async () => {
  const { removals, deps } = setup()

  expect(await removals.remove('note-1', editorOn(null))).toBe(true)
  expect(await removals.remove('note-2', editorOn(null))).toBe(true)

  expect(deps.flush).toHaveBeenCalledTimes(2)
  expect(deps.discard.mock.calls).toEqual([['note-1'], ['note-2']])
  expect((await removals.undo())?.id).toBe('note-2')
  expect((await removals.undo())?.id).toBe('note-1')
  expect(deps.resume.mock.calls).toEqual([['note-2'], ['note-1']])
  expect(await removals.undo()).toBeNull()
})

test('a Note whose edits could not be saved is not removed, so undo would not lose them', async () => {
  const { removals, deps, unsaved } = setup()
  unsaved.add('note-1')

  expect(await removals.remove('note-1', editorOn(null))).toBe(false)

  expect(deps.remove).not.toHaveBeenCalled()
  expect(deps.discard).not.toHaveBeenCalled()
  expect(await removals.undo()).toBeNull()
})

test('a removal the Backend refuses leaves nothing to undo', async () => {
  const { removals, deps } = setup()
  deps.remove.mockImplementationOnce(() => Promise.reject(new Error('unreachable')))

  expect(await removals.remove('note-1', editorOn(null))).toBe(false)

  expect(deps.discard).not.toHaveBeenCalled()
  expect(await removals.undo()).toBeNull()
})

test('an undo that fails can be tried again', async () => {
  const { removals, deps } = setup()
  await removals.remove('note-1', editorOn(null))
  deps.restore.mockImplementationOnce(() => Promise.reject(new Error('unreachable')))

  expect(await removals.undo()).toBeNull()
  expect(deps.resume).not.toHaveBeenCalled()
  expect((await removals.undo())?.id).toBe('note-1')
})

test('nothing is saved to the open Note while it is being removed, and when the removal fails its edits are saved again', async () => {
  const { removals, deps } = setup()
  const open = repoNote('note-1')
  const editor = editorOn(open)
  let savedTo: Note | null | undefined
  deps.remove.mockImplementationOnce(() => {
    savedTo = editor.noteRef.current
    return Promise.reject(new Error('unreachable'))
  })

  expect(await removals.remove('note-1', editor)).toBe(false)

  expect(savedTo).toBeNull()
  expect(editor.noteRef.current).toBe(open)
  expect(editor.reschedule).toHaveBeenCalledWith(open)
})

test('a Note opened while the removal fails keeps the edits typed into it', async () => {
  const { removals, deps } = setup()
  const editor = editorOn(repoNote('note-1'))
  const other = repoNote('note-2')
  deps.remove.mockImplementationOnce(() => {
    editor.noteRef.current = other
    return Promise.reject(new Error('unreachable'))
  })

  expect(await removals.remove('note-1', editor)).toBe(false)

  expect(editor.noteRef.current).toBe(other)
  expect(editor.reschedule).not.toHaveBeenCalled()
})

test('a removed Note that was open is not saved to again', async () => {
  const { removals } = setup()
  const editor = editorOn(repoNote('note-1'))

  expect(await removals.remove('note-1', editor)).toBe(true)

  expect(editor.noteRef.current).toBeNull()
  expect(editor.reschedule).not.toHaveBeenCalled()
})
