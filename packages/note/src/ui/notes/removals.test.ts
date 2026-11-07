import { expect, mock, test } from 'bun:test'

import { ORPCError } from '@orpc/client'

import type { Note } from '../../contract.ts'
import { isNotFound, type RemovableKind, Removals } from './removals.ts'

const at = new Date(2026, 9, 6, 12)

function note(kind: RemovableKind, id: string): Note {
  const fields = {
    id,
    title: '',
    starred: false,
    date: '2026-10-06',
    content: { type: 'doc' as const },
  }
  return kind === 'essay'
    ? { kind, ...fields, status: 'writing', createdAt: at, updatedAt: at }
    : { kind, ...fields, repo: 'acme/app', createdAt: at, updatedAt: at }
}

/** `open` は URL が開いている Note の id。 */
function setup(kind: RemovableKind, open: string | null = null) {
  const unsaved = new Set<string>()
  let url = open
  const deps = {
    flush: mock(() => Promise.resolve()),
    hasUnsaved: (id: string) => unsaved.has(id),
    remove: mock((_id: string) => Promise.resolve()),
    restore: mock((id: string) => Promise.resolve(note(kind, id))),
    discard: mock((_id: string) => {}),
    forgetBody: mock((_id: string) => {}),
    openId: () => url,
  }
  return {
    removals: new Removals(kind, deps),
    deps,
    unsaved,
    leave: mock(() => {}),
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

test('the screen leaves a removed Note only when the URL points at it once the removal is done', async () => {
  for (const [from, to, leaves] of [
    ['note-9', 'note-1', true],
    ['note-1', 'note-2', false],
    ['note-9', 'note-9', false],
  ] as const) {
    const { removals, deps, leave, browse } = setup('repo_note', from)
    deps.remove.mockImplementationOnce(() => {
      browse(to)
      return Promise.resolve()
    })

    expect(await removals.remove('note-1', { leave })).toBe(true)

    expect(leave.mock.calls.length, `${from} → ${to}`).toBe(leaves ? 1 : 0)
  }
})

test('a removal the Backend refuses leaves nothing to undo and stays on the Note', async () => {
  const { removals, deps, leave } = setup('essay', 'note-1')
  deps.remove.mockImplementationOnce(() => Promise.reject(new Error('unreachable')))

  expect(await removals.remove('note-1', { leave })).toBe(false)

  expect(deps.discard).not.toHaveBeenCalled()
  expect(deps.forgetBody).not.toHaveBeenCalled()
  expect(leave).not.toHaveBeenCalled()
  expect(await removals.undo()).toBeNull()
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

test('a Note removed elsewhere drops its saves and cached body, and the screen leaves it', () => {
  const { removals, deps, leave } = setup('essay', 'note-1')

  removals.removedElsewhere('note-1', { leave })

  expect(deps.discard.mock.calls).toEqual([['note-1']])
  expect(deps.forgetBody.mock.calls).toEqual([['note-1']])
  expect(leave).toHaveBeenCalledTimes(1)
  expect(deps.remove).not.toHaveBeenCalled()
})

test('a Note removed elsewhere is not pushed on the undo stack', async () => {
  const { removals, deps, leave } = setup('repo_note', 'note-1')
  await removals.remove('note-0', { leave })

  removals.removedElsewhere('note-1', { leave })

  expect((await removals.undo())?.id).toBe('note-0')
  expect(await removals.undo()).toBeNull()
  expect(deps.restore.mock.calls).toEqual([['note-0']])
})

test('the screen leaves a Note removed elsewhere only while the URL still points at it', () => {
  const { removals, deps, leave, browse } = setup('essay', 'note-1')
  browse('note-2')

  removals.removedElsewhere('note-1', { leave })

  expect(deps.discard.mock.calls).toEqual([['note-1']])
  expect(leave).not.toHaveBeenCalled()
})

test('only a NOT_FOUND answer from the Backend means the Note was removed', () => {
  expect(isNotFound(new ORPCError('NOT_FOUND'))).toBe(true)
  expect(isNotFound(new ORPCError('INTERNAL_SERVER_ERROR'))).toBe(false)
  expect(isNotFound(new Error('NOT_FOUND'))).toBe(false)
  expect(isNotFound(null)).toBe(false)
})
