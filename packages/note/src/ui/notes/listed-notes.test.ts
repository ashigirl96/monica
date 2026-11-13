import { afterEach, expect, test } from 'bun:test'

import type { InfiniteData } from '@tanstack/react-query'

import type { EssaySummary, RepoNotesCursor, RepoNotesPage } from '../../contract.ts'
import { inMemoryNoteClient } from '../../testing.ts'
import type { NoteClient } from '../client.ts'
import { createQueryClient, queryKeys } from '../query.ts'
import { ESSAYS_PATH, essayPath, notePath, repoNotePath, repoPath, routeOf } from '../routes.ts'
import { type ListedScreen, ListedNotes } from './listed-notes.ts'
import { cleanups, fakeBrowser, holdable, until } from './note-fixture.ts'
import { SaveQueue } from './save-queue.ts'

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

const REPO = 'acme/notes'

type RepoNotesData = InfiniteData<RepoNotesPage, RepoNotesCursor | undefined>

function setup(screen: ListedScreen, path: string) {
  fakeBrowser()
  const queryClient = createQueryClient()
  queryClient.mount()
  cleanups.push(() => queryClient.unmount())
  const backend = inMemoryNoteClient() as unknown as NoteClient
  const { client, hold, calls } = holdable(backend)
  const saves = new SaveQueue((input) => client.save(input))
  let pathname = path
  const moves: string[] = []
  const state = { beforeMove: (_to: string) => {} }
  const notes = new ListedNotes(screen, {
    queryClient,
    client,
    saves,
    showOpen: () => {},
    pathname: () => pathname,
    navigate: (to) => {
      state.beforeMove(to)
      pathname = to
      moves.push(to)
    },
  })
  cleanups.push(notes.attach())
  notes.present(routeOf(path))

  /** 利用者が移り、React がその route を描く。 */
  const go = (to: string) => {
    pathname = to
    notes.present(routeOf(to))
  }
  const essays = () => queryClient.getQueryData<EssaySummary[]>(queryKeys.essays()) ?? []
  return {
    backend,
    queryClient,
    notes,
    calls,
    hold,
    moves,
    state,
    go,
    /** navigate の後に React が描く。 */
    draw: () => notes.present(routeOf(pathname)),
    shown: (id: string) => until(() => notes.view().open.note?.id === id),
    essays,
    essayIds: () => essays().map((essay) => essay.id),
    fetchEssays: () =>
      queryClient.fetchQuery({ queryKey: queryKeys.essays(), queryFn: () => client.essay.list() }),
    listInvalidated: (key: readonly unknown[]) =>
      queryClient.getQueryState(key)?.isInvalidated ?? false,
  }
}

async function threeEssays(s: ReturnType<typeof setup>) {
  for (let i = 0; i < 3; i++) await s.backend.essay.create()
  await s.fetchEssays()
  return s.essayIds()
}

const lastSegment = (path: string) => path.split('/').at(-1)!

test.each([
  ['an Essay from the grid', { kind: 'essay' } as const, ESSAYS_PATH],
  ['an Essay from the editor', { kind: 'essay' } as const, 'editor'],
  ['a Repo Note from Scratch', { kind: 'repo_note', repo: REPO } as const, repoPath(REPO)],
])(
  '%s is put in the body cache before moving to it, starts at its title, and the list is fetched again',
  async (_, screen, from) => {
    const s = setup(screen, screen.kind === 'essay' ? ESSAYS_PATH : repoPath(REPO))
    if (from === 'editor') {
      const [open] = await threeEssays(s)
      s.go(essayPath(open!))
      await s.shown(open!)
    }
    const listKey = screen.kind === 'essay' ? queryKeys.essays() : queryKeys.repoNotes(REPO)
    s.queryClient.setQueryData(
      listKey,
      screen.kind === 'essay' ? [] : { pages: [], pageParams: [] },
    )
    s.state.beforeMove = (to) => {
      const id = lastSegment(to)
      expect(s.queryClient.getQueryData(queryKeys.note(id))).toMatchObject({
        id,
        kind: screen.kind,
      })
      expect(s.notes.view().titleFocusId).toBe(id)
    }

    await s.notes.create()

    expect(s.moves).toHaveLength(1)
    expect(s.listInvalidated(listKey)).toBe(true)
  },
)

test('a removed open Essay leaves to the next one shown before the list drops it, and undo after a relay route brings it back', async () => {
  const s = setup({ kind: 'essay' }, ESSAYS_PATH)
  const [, target, next] = await threeEssays(s)
  s.go(essayPath(target!))
  await s.shown(target!)
  s.state.beforeMove = () => expect(s.essayIds()).toContain(target!)

  await s.notes.remove(target!)

  expect(s.moves).toEqual([essayPath(next!)])
  expect(s.essayIds()).not.toContain(target!)
  expect(s.queryClient.getQueryData(queryKeys.note(target!))).toBeUndefined()

  s.draw()
  s.go(notePath(next!))
  s.go(essayPath(next!))
  s.state.beforeMove = () =>
    expect(s.queryClient.getQueryData(queryKeys.note(target!))).toMatchObject({ id: target })
  await s.notes.undo()

  expect(s.moves.at(-1)).toBe(essayPath(target!))
  expect(s.listInvalidated(queryKeys.essays())).toBe(true)
})

test('on the Essay grid, delete, undo and the status menu stay on the grid', async () => {
  const s = setup({ kind: 'essay' }, ESSAYS_PATH)
  const [first, second] = await threeEssays(s)

  await s.notes.remove(first!)
  expect(s.essayIds()).not.toContain(first!)
  await s.notes.undo()
  await s.notes.setEssayStatus(second!, 'finished')

  expect(s.moves).toEqual([])
  expect(s.calls.filter((call) => call === 'remove' || call === 'restore')).toEqual([
    'remove',
    'restore',
  ])
  expect(s.essays().find((essay) => essay.id === second)?.status).toBe('finished')
  expect(s.queryClient.getQueryData(queryKeys.note(second!))).toBeUndefined()
})

test.each(['list', 'note'])(
  'an Essay removed elsewhere leaves to the next one shown and is not undone, when the %s comes back first',
  async (first) => {
    const s = setup({ kind: 'essay' }, ESSAYS_PATH)
    const [, gone, next] = await threeEssays(s)
    s.go(essayPath(gone!))
    await s.shown(gone!)
    await s.backend.remove({ id: gone! })

    const refetchNote = () => s.queryClient.refetchQueries({ queryKey: queryKeys.note(gone!) })
    if (first === 'list') await s.fetchEssays()
    await refetchNote()
    await until(() => s.moves.length > 0)
    if (first === 'note') await s.fetchEssays()
    await refetchNote()
    await s.notes.undo()

    expect(s.moves).toEqual([essayPath(next!)])
    expect(s.essayIds()).not.toContain(gone!)
    expect(s.queryClient.getQueryData(queryKeys.note(gone!))).toBeUndefined()
    expect(s.calls).not.toContain('restore')
  },
)

test('the list follows the title typed and the status the Backend returns, even after moving to another Essay mid-request', async () => {
  const s = setup({ kind: 'essay' }, ESSAYS_PATH)
  const [open, other] = await threeEssays(s)
  s.go(essayPath(open!))
  await s.shown(open!)
  const before = s.essays()
  const row = (id: string) => s.essays().find((essay) => essay.id === id)

  s.notes.changeTitle('Field notes')
  await s.notes.toggleEssayStatus()

  expect(row(open!)).toMatchObject({ title: 'Field notes', status: 'finished' })
  expect(row(other!)).toBe(before.find((essay) => essay.id === other)!)
  expect(s.notes.view().tab).toBe('finished')

  const held = s.hold('essay.setStatus')
  const toggling = s.notes.toggleEssayStatus()
  await held.entered
  s.go(essayPath(other!))
  await s.shown(other!)
  held.release()
  await toggling

  expect(row(open!)?.status).toBe('writing')
})

test('a Repo Note list keeps its pages and cursors when a row is renamed or removed, and an open removed Repo Note leaves to Scratch', async () => {
  const s = setup({ kind: 'repo_note', repo: REPO }, repoPath(REPO))
  for (let i = 0; i < 3; i++) await s.backend.repoNote.create({ repo: REPO })
  const [head, open, tail] = (await s.backend.repoNote.list({ repo: REPO })).notes
  const cursor = { starred: head!.starred, date: head!.date, id: head!.id }
  const data: RepoNotesData = {
    pages: [
      { notes: [head!], next: cursor },
      { notes: [open!, tail!], next: null },
    ],
    pageParams: [undefined, cursor],
  }
  s.queryClient.setQueryData(queryKeys.repoNotes(REPO), data)
  const list = () => s.queryClient.getQueryData<RepoNotesData>(queryKeys.repoNotes(REPO))!
  s.go(repoNotePath(REPO, open!.id))
  await s.shown(open!.id)

  s.notes.changeTitle('Second')
  await s.notes.remove(tail!.id)

  expect(list().pageParams).toBe(data.pageParams)
  expect(list().pages[0]).toBe(data.pages[0]!)
  expect(list().pages[1]).toMatchObject({ notes: [{ id: open!.id, title: 'Second' }], next: null })
  expect(s.moves).toEqual([])

  await s.notes.remove(open!.id)

  expect(s.moves).toEqual([repoPath(REPO)])
  expect(list().pages[1]?.notes).toEqual([])
})

test('two Star presses each read the Star before sending its opposite, one after the other', async () => {
  const s = setup({ kind: 'essay' }, ESSAYS_PATH)
  const [id] = await threeEssays(s)
  const read = s.hold('get')

  const first = s.notes.toggleStar(id!)
  const second = s.notes.toggleStar(id!)
  await read.entered
  expect(s.calls).not.toContain('star')
  read.release()
  await Promise.all([first, second])

  expect(s.calls.filter((call) => call === 'get' || call === 'star')).toEqual([
    'get',
    'star',
    'get',
    'star',
  ])
  expect(await s.backend.get({ id: id! })).toMatchObject({ starred: false })
  expect(s.listInvalidated(queryKeys.essays())).toBe(true)
})

test('an Essay route showing another kind of Note leaves the keys to the editor and removes nothing', async () => {
  const s = setup({ kind: 'essay' }, ESSAYS_PATH)
  const note = await s.backend.repoNote.create({ repo: REPO })
  s.go(essayPath(note.id))
  await s.shown(note.id)

  await s.notes.remove(note.id)

  expect(s.notes.listedOpenId()).toBeNull()
  expect(s.calls).not.toContain('remove')
})
