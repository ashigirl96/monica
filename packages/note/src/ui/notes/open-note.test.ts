import { afterEach, expect, mock, test } from 'bun:test'

import type { Doc, Note } from '../../contract.ts'
import { inMemoryNoteClient } from '../../testing.ts'
import type { NoteClient } from '../client.ts'
import { createQueryClient, queryKeys } from '../query.ts'
import { dayLabelWithYear } from './dates.ts'
import { cleanups, doc, fakeBrowser, holdable, until } from './note-fixture.ts'
import { OpenNote } from './open-note.ts'
import { dailyOrPadQueryOptions, noteQueryOptions } from './queries.ts'
import { type RemovableKind, Removals } from './removals.ts'
import { SaveQueue } from './save-queue.ts'

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

function setup() {
  fakeBrowser()
  const queryClient = createQueryClient()
  queryClient.mount()
  cleanups.push(() => queryClient.unmount())
  const backend = inMemoryNoteClient() as unknown as NoteClient
  const { client, hold, calls } = holdable(backend)
  const saves = new SaveQueue((input) => client.save(input))
  let url: string | null = null
  const shown: (string | null)[] = []
  const openNote = new OpenNote({
    queryClient,
    saves,
    client,
    showOpen: (id) => shown.push(id),
    openId: () => url,
  })
  const detach = openNote.attach()
  cleanups.push(detach)

  const removals = (kind: RemovableKind) =>
    new Removals(kind, {
      flush: saves.flush,
      hasUnsaved: saves.hasUnsaved,
      remove: (id) => client.remove({ id }),
      restore: (id) => client.restore({ id }),
      discard: saves.discard,
      forgetBody: (id) => queryClient.removeQueries({ queryKey: queryKeys.note(id), exact: true }),
      openId: () => url,
    })

  /** URL を移し、Note が画面に出るまで待つ。 */
  async function open(note: Note): Promise<Note> {
    url = note.id
    openNote.open(note.id, noteQueryOptions(client, note.id))
    await until(() => openNote.view().note?.id === note.id)
    return note
  }

  /** 別のタブがその Note を保存する。 */
  async function elsewhere(id: string, edit: { content?: Doc; title?: string }) {
    const latest = await backend.get({ id })
    await backend.save({
      id,
      content: edit.content ?? latest.content,
      title: edit.title,
      expectedUpdatedAt: latest.updatedAt,
    })
  }

  async function conflicted(id: string) {
    await elsewhere(id, { content: doc('theirs') })
    openNote.changeBody(doc('mine'))
    await saves.flush()
    expect(saves.conflicts().map((c) => c.id)).toEqual([id])
  }

  return {
    backend,
    client,
    queryClient,
    saves,
    openNote,
    calls,
    hold,
    removals,
    open,
    elsewhere,
    conflicted,
    shown,
    detach,
    browse: (id: string | null) => {
      url = id
    },
    essay: () => backend.essay.create(),
    refetch: (id: string) => queryClient.refetchQueries({ queryKey: queryKeys.note(id) }),
  }
}

test('a reload that fails keeps the edits typed and the conflict, and takes nothing', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())
  await s.conflicted(essay.id)
  const before = s.openNote.view().note
  const get = s.hold('get')

  const reloading = s.openNote.reload()
  await get.entered
  get.fail()
  await reloading

  expect(s.saves.hasUnsaved(essay.id)).toBe(true)
  expect(s.saves.conflicts().map((c) => c.id)).toEqual([essay.id])
  expect(s.openNote.view().note).toBe(before)
})

test('a reload that goes through drops the edits typed and takes the latest', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())
  await s.conflicted(essay.id)
  const { generation } = s.openNote.view()

  await s.openNote.reload()

  const latest = await s.backend.get({ id: essay.id })
  expect(s.saves.hasUnsaved(essay.id)).toBe(false)
  expect(s.saves.conflicts()).toEqual([])
  expect(s.openNote.view().note?.content).toEqual(doc('theirs'))
  expect(s.openNote.view().generation).toBe(generation + 1)
  expect(s.saves.baseVersion(essay.id)).toEqual(latest.updatedAt)
})

test('a reload does not take the Note when the screen moved to another Note meanwhile', async () => {
  const s = setup()
  const first = await s.open(await s.essay())
  const second = await s.essay()
  await s.conflicted(first.id)
  const get = s.hold('get')

  const reloading = s.openNote.reload()
  await get.entered
  await s.open(second)
  get.release()
  await reloading

  expect(s.openNote.view().note?.id).toBe(second.id)
  expect(s.saves.conflicts().map((c) => c.id)).toEqual([first.id])
})

test('edits typed while reloading are kept as the conflict', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())
  await s.conflicted(essay.id)
  const before = s.openNote.view().note
  const get = s.hold('get')

  const reloading = s.openNote.reload()
  await get.entered
  s.openNote.changeBody(doc('more'))
  get.release()
  await reloading

  expect(s.saves.hasUnsaved(essay.id)).toBe(true)
  expect(s.saves.conflicts().map((c) => c.id)).toEqual([essay.id])
  expect(s.openNote.view().note).toBe(before)
})

test('the status goes to the next one, the next save is based on the version it gets back, and the screen shows that Essay', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())
  const { generation } = s.openNote.view()

  for (const status of ['finished', 'writing'] as const) {
    const updated = await s.openNote.toggleStatus()

    expect(updated).toMatchObject({ id: essay.id, status })
    expect(s.openNote.view().note).toEqual(updated)
    expect(s.openNote.view().generation).toBe(generation)
    expect(s.saves.baseVersion(essay.id)).toEqual(updated?.updatedAt ?? null)
  }
  s.openNote.changeBody(doc('after'))
  await s.saves.flush()
  expect(s.saves.hasUnsaved(essay.id)).toBe(false)
})

test('the body and title changed elsewhere come back with the status and are drawn again', async () => {
  for (const changed of [{ content: doc('theirs') }, { title: 'Retitled' }]) {
    const s = setup()
    const essay = await s.open(await s.essay())
    await s.elsewhere(essay.id, changed)
    const { generation } = s.openNote.view()

    const updated = await s.openNote.toggleStatus()

    expect(s.openNote.view().note).toEqual(updated)
    expect(s.openNote.view().note).toMatchObject(changed)
    expect(s.openNote.view().generation).toBe(generation + 1)
  }
})

test('the version stays when the Essay was changed elsewhere and an edit was typed while the status was being set', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())
  const setStatus = s.hold('essay.setStatus')

  const toggling = s.openNote.toggleStatus()
  await setStatus.entered
  await s.elsewhere(essay.id, { title: 'Retitled' })
  s.openNote.changeBody(doc('typed'))
  setStatus.release()

  expect(await toggling).toMatchObject({ status: 'finished', title: 'Retitled' })
  expect(s.saves.baseVersion(essay.id)).toEqual(essay.updatedAt)
  expect(s.openNote.view().note).toMatchObject({ status: 'finished', title: '' })
})

test('the status waits for the pending edit to be saved', async () => {
  const s = setup()
  await s.open(await s.essay())
  s.openNote.changeBody(doc('typed'))
  const save = s.hold('save')

  const toggling = s.openNote.toggleStatus()
  await save.entered
  expect(s.calls).not.toContain('essay.setStatus')
  save.release()

  expect(await toggling).toMatchObject({ status: 'finished' })
  expect(s.calls.slice(-2)).toEqual(['save', 'essay.setStatus'])
})

test('the status stays when an edit is left unsaved after flushing', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())
  s.openNote.changeBody(doc('typed'))
  const save = s.hold('save')

  const toggling = s.openNote.toggleStatus()
  await save.entered
  save.fail()

  expect(await toggling).toBeNull()
  expect(s.calls).not.toContain('essay.setStatus')
  expect(await s.backend.get({ id: essay.id })).toMatchObject({ status: 'writing' })
})

test('only the status is taken when an edit was typed while it was being set', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())
  const setStatus = s.hold('essay.setStatus')
  const { generation } = s.openNote.view()

  const toggling = s.openNote.toggleStatus()
  await setStatus.entered
  s.openNote.changeBody(doc('typed'))
  setStatus.release()
  const updated = await toggling

  expect(s.saves.baseVersion(essay.id)).toEqual(updated?.updatedAt ?? null)
  expect(s.openNote.view().note).toMatchObject({ status: 'finished', content: essay.content })
  expect(s.openNote.view().generation).toBe(generation)
  await s.saves.flush()
  expect(await s.backend.get({ id: essay.id })).toMatchObject({ content: doc('typed') })
})

test('the screen is left alone when another Note was opened while the status was being set', async () => {
  const s = setup()
  const first = await s.open(await s.essay())
  const second = await s.essay()
  const setStatus = s.hold('essay.setStatus')

  const toggling = s.openNote.toggleStatus()
  await setStatus.entered
  await s.open(second)
  setStatus.release()
  const updated = await toggling

  expect(updated).toMatchObject({ id: first.id, status: 'finished' })
  expect(s.saves.baseVersion(first.id)).toEqual(updated?.updatedAt ?? null)
  expect(s.openNote.view().note?.id).toBe(second.id)
})

test('the status of an Essay no longer open, or of another kind of Note, is left alone', async () => {
  const nothingOpen = setup()
  expect(await nothingOpen.openNote.toggleStatus()).toBeNull()

  const daily = setup()
  daily.openNote.open('2026-10-07', dailyOrPadQueryOptions(daily.backend, '2026-10-07'))
  await until(() => daily.openNote.view().note !== null)
  expect(await daily.openNote.toggleStatus()).toBeNull()
  expect(daily.calls).not.toContain('essay.setStatus')

  const moved = setup()
  await moved.open(await moved.essay())
  const second = await moved.essay()
  const setStatus = moved.hold('essay.setStatus')
  const first = moved.openNote.toggleStatus()
  await setStatus.entered
  const queued = moved.openNote.toggleStatus()
  await moved.open(second)
  setStatus.release()
  await first
  expect(await queued).toBeNull()
  expect(moved.calls.filter((call) => call === 'essay.setStatus')).toHaveLength(1)
})

test('pressing the status twice in a row moves it twice', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())

  const presses = [s.openNote.toggleStatus(), s.openNote.toggleStatus()]

  expect((await Promise.all(presses)).map((note) => note?.kind === 'essay' && note.status)).toEqual(
    ['finished', 'writing'],
  )
  expect(await s.backend.get({ id: essay.id })).toMatchObject({ status: 'writing' })
})

/** 保存し切れずに未保存が残るか、Backend が削除を断る。 */
const refusals = [
  [
    'an edit left unsaved',
    async (s: ReturnType<typeof setup>, removing: () => Promise<boolean>) => {
      s.openNote.changeBody(doc('pending'))
      const save = s.hold('save')
      const removed = removing()
      await save.entered
      return { removed, refuse: save.fail }
    },
  ],
  [
    'the Backend refusing',
    async (s: ReturnType<typeof setup>, removing: () => Promise<boolean>) => {
      const remove = s.hold('remove')
      const removed = removing()
      await remove.entered
      return { removed, refuse: remove.fail }
    },
  ],
] as const

test('a removal that does not go through leaves nothing to undo and stays on the Note', async () => {
  for (const [why, refusing] of refusals) {
    const s = setup()
    const essay = await s.open(await s.essay())
    const removals = s.removals('essay')
    const leave = mock(() => {})

    const { removed, refuse } = await refusing(s, () =>
      s.openNote.remove(essay.id, removals, leave),
    )
    refuse()

    expect(await removed, why).toBe(false)
    expect(leave, why).not.toHaveBeenCalled()
    expect(await removals.undo(), why).toBeNull()
    expect((await s.backend.get({ id: essay.id })).id, why).toBe(essay.id)
    expect(s.openNote.view().note?.id, why).toBe(essay.id)
  }
})

test('nothing is saved to the open Note while it is being removed, and when the removal does not go through its edits are saved again', async () => {
  for (const [why, refusing] of refusals) {
    const s = setup()
    const essay = await s.open(await s.essay())

    const { removed, refuse } = await refusing(s, () =>
      s.openNote.remove(essay.id, s.removals('essay'), () => {}),
    )
    s.openNote.changeBody(doc('typed'))
    const scheduled = s.calls.length
    refuse()

    expect(await removed, why).toBe(false)
    expect(s.calls.length, why).toBe(scheduled)
    expect(s.saves.hasUnsaved(essay.id), why).toBe(true)
    await s.saves.flush()
    expect((await s.backend.get({ id: essay.id })).content, why).toEqual(doc('typed'))
  }
})

test('a Note taken up while the removal fails keeps the edits typed into it', async () => {
  const s = setup()
  const first = await s.open(await s.essay())
  const second = await s.essay()
  const remove = s.hold('remove')

  const removing = s.openNote.remove(first.id, s.removals('essay'), () => {})
  await remove.entered
  await s.open(second)
  remove.fail()

  expect(await removing).toBe(false)
  expect(s.openNote.editing?.id).toBe(second.id)
  s.openNote.changeBody(doc('typed'))
  expect(s.saves.hasUnsaved(second.id)).toBe(true)
  expect(s.saves.hasUnsaved(first.id)).toBe(false)
})

test('a newer version of the Note taken up while the removal fails is not replaced by the one being removed', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())
  const remove = s.hold('remove')

  const removing = s.openNote.remove(essay.id, s.removals('essay'), () => {})
  await remove.entered
  await s.elsewhere(essay.id, { title: 'Retitled elsewhere' })
  await s.refetch(essay.id)
  await until(() => s.openNote.editing !== null)
  remove.fail()

  expect(await removing).toBe(false)
  expect(s.openNote.editing).toMatchObject({ title: 'Retitled elsewhere' })
  expect(s.saves.hasUnsaved(essay.id)).toBe(false)
})

test('a removed Note that was open is not saved to again, and the screen leaves it', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())
  const leave = mock(() => {})

  expect(await s.openNote.remove(essay.id, s.removals('essay'), leave)).toBe(true)

  s.openNote.changeBody(doc('typed'))
  expect(s.saves.hasUnsaved(essay.id)).toBe(false)
  expect(leave).toHaveBeenCalledTimes(1)
})

test('a removal that fails after the screen moved to another Note does not open the Note again before the move is drawn', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())
  s.openNote.changeBody(doc('pending'))
  const save = s.hold('save')

  const removing = s.openNote.remove(essay.id, s.removals('essay'), () => {})
  await save.entered
  s.browse('note-elsewhere')
  save.fail()

  expect(await removing).toBe(false)
  expect(s.openNote.editing).toBeNull()
})

test('an open Note of a kind the screen does not remove is left alone', async () => {
  const essayScreen = setup()
  essayScreen.openNote.open('2026-10-07', dailyOrPadQueryOptions(essayScreen.backend, '2026-10-07'))
  await until(() => essayScreen.openNote.editing !== null)
  const daily = essayScreen.openNote.editing
  const repoScreen = setup()
  await repoScreen.open(await repoScreen.essay())
  const essay = repoScreen.openNote.editing

  for (const [s, kind, open] of [
    [essayScreen, 'essay', daily],
    [repoScreen, 'repo_note', essay],
  ] as const) {
    expect(await s.openNote.remove(open?.id ?? '', s.removals(kind), () => {}), kind).toBe(false)
    expect(s.calls, kind).not.toContain('remove')
    expect(s.openNote.editing, kind).toBe(open)
  }
})

test('a Note removed elsewhere is not saved to again', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())

  await s.backend.remove({ id: essay.id })
  await s.refetch(essay.id)
  await until(() => s.openNote.view().gone !== null)

  expect(s.openNote.view().gone).toBe(essay.id)
  s.openNote.changeBody(doc('typed'))
  expect(s.saves.hasUnsaved(essay.id)).toBe(false)
})

test('a Note removed elsewhere is gone only while the screen shows it', async () => {
  const s = setup()
  const first = await s.open(await s.essay())
  const second = await s.open(await s.essay())
  await s.backend.remove({ id: first.id })
  await s.refetch(first.id)

  expect(s.openNote.view().gone).toBeNull()
  s.openNote.changeBody(doc('typed'))
  expect(s.saves.hasUnsaved(second.id)).toBe(true)

  const never = setup()
  const removed = await never.essay()
  await never.backend.remove({ id: removed.id })
  never.openNote.open(removed.id, noteQueryOptions(never.backend, removed.id))
  await until(() => never.openNote.view().error !== null)
  expect(never.openNote.view().gone).toBeNull()
})

test('a Note whose body the editor cannot read is not saved, neither its body nor its title', async () => {
  const s = setup()
  const essay = await s.essay()
  s.queryClient.setQueryData(queryKeys.note(essay.id), {
    ...essay,
    content: { type: 'doc', content: [{ type: 'nonsense' }] },
  })
  await s.open(essay)

  s.openNote.changeBody(doc('typed'))
  s.openNote.changeTitle('Retitled')

  expect(s.saves.hasUnsaved(essay.id)).toBe(false)
})

test('the cache one version older than the save just made is not shown', async () => {
  const s = setup()
  const first = await s.open(await s.essay())
  const second = await s.essay()
  s.openNote.changeBody(doc('typed'))
  await s.saves.flush()
  await s.open(second)
  const get = s.hold('get')

  s.openNote.open(first.id, noteQueryOptions(s.client, first.id))
  await get.entered
  expect(s.openNote.view().note).toBeNull()
  get.release()

  await until(() => s.openNote.view().note?.id === first.id)
  expect(s.openNote.view().note?.content).toEqual(doc('typed'))
})

test('a newer version saved elsewhere is not taken while an edit is unsaved', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())
  const before = s.openNote.view()
  s.openNote.changeBody(doc('typed'))

  await s.elsewhere(essay.id, { content: doc('theirs') })
  await s.refetch(essay.id)

  expect(s.openNote.view().note).toBe(before.note)
  expect(s.openNote.view().generation).toBe(before.generation)
})

test('once another Note is being opened, nothing is saved to the Note before it', async () => {
  const s = setup()
  const first = await s.open(await s.essay())
  const second = await s.essay()
  const get = s.hold('get')

  s.openNote.open(second.id, noteQueryOptions(s.client, second.id))
  await get.entered
  s.openNote.changeBody(doc('typed'))
  get.release()

  expect(s.saves.hasUnsaved(first.id)).toBe(false)
  expect(s.saves.hasUnsaved(second.id)).toBe(false)
})

test('autosave is told the Note on the screen, and no Note once the screen is gone', async () => {
  const s = setup()
  const essay = await s.open(await s.essay())

  s.detach()

  expect(s.shown).toEqual([essay.id, null])
})

test('the title is saved only with the Notes that have one, and a conflict is headed by the name of the Note', async () => {
  const essayScreen = setup()
  const essay = await essayScreen.open(await essayScreen.essay())
  essayScreen.openNote.changeTitle('Titled')
  await essayScreen.saves.flush()
  expect(await essayScreen.backend.get({ id: essay.id })).toMatchObject({ title: 'Titled' })
  await essayScreen.elsewhere(essay.id, { content: doc('theirs') })
  essayScreen.openNote.changeBody(doc('mine'))
  await essayScreen.saves.flush()
  expect(essayScreen.saves.conflicts()).toEqual([{ id: essay.id, label: 'Titled' }])

  const dailyScreen = setup()
  const date = '2026-10-07'
  dailyScreen.openNote.open(date, dailyOrPadQueryOptions(dailyScreen.client, date))
  await until(() => dailyScreen.openNote.editing !== null)
  const daily = dailyScreen.openNote.editing
  dailyScreen.openNote.changeBody(doc('typed'))
  await dailyScreen.saves.flush()
  expect(dailyScreen.saves.hasUnsaved(daily?.id ?? '')).toBe(false)
  expect((await dailyScreen.backend.get({ id: daily?.id ?? '' })).content).toEqual(doc('typed'))
  await dailyScreen.elsewhere(daily?.id ?? '', { content: doc('theirs') })
  dailyScreen.openNote.changeBody(doc('mine'))
  await dailyScreen.saves.flush()
  expect(dailyScreen.saves.conflicts()).toEqual([
    { id: daily?.id ?? '', label: dayLabelWithYear(date) },
  ])
})

test('a Note the screen does not accept is not taken up', async () => {
  const s = setup()
  const essay = await s.essay()

  s.openNote.open(essay.id, noteQueryOptions(s.client, essay.id), () => false)
  await until(() => s.openNote.view().data !== undefined)

  expect(s.openNote.view().note).toBeNull()
  expect(s.openNote.editing).toBeNull()
})
