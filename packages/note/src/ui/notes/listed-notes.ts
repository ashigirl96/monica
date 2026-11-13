import type { InfiniteData, QueryClient } from '@tanstack/react-query'

import type {
  EssayStatus,
  EssaySummary,
  Note,
  RepoNoteSummary,
  RepoNotesCursor,
  RepoNotesPage,
} from '../../contract.ts'
import type { NoteClient } from '../client.ts'
import { queryKeys } from '../query.ts'
import {
  ESSAYS_PATH,
  essayPath,
  openNoteIdOfPath,
  type RemovalScreen,
  repoNotePath,
  repoNoteRedirect,
  repoPath,
  type Route,
  routeOf,
} from '../routes.ts'
import { cycleSelect } from './editor-support.ts'
import { emptyView, OpenNote, type OpenNoteView } from './open-note.ts'
import { type NoteQueryOptions, noteQueryOptions, scratchQueryOptions } from './queries.ts'
import { Removals } from './removals.ts'
import type { SaveQueue } from './save-queue.ts'
import { createStarToggle } from './star-toggle.ts'

export type ListedScreen = NonNullable<RemovalScreen>

export type ListedNotesView = {
  open: OpenNoteView
  /** ⌥N で作った Note。本文ではなく title から書き始める。 */
  titleFocusId: string | null
  /** Essay のサイドバーが並べる status。 */
  tab: EssayStatus
}

type ListedNotesDeps = {
  queryClient: QueryClient
  client: NoteClient
  saves: SaveQueue
  /** 画面に出ている Note を autosave に知らせる。 */
  showOpen: (id: string | null) => void
  /** URL の pathname。navigate は URL をその場で書き換えるが、描画は後になる。 */
  pathname: () => string
  navigate: (path: string, options?: { replace?: boolean }) => void
}

type RepoNotesData = InfiniteData<RepoNotesPage, RepoNotesCursor | undefined>
type RowEdit = <T extends EssaySummary | RepoNoteSummary>(row: T) => T | null

/** route が開く Note の名前。Repo の Scratch は id が取るまで分からないので Repo で呼ぶ。 */
export function openKeyOf(route: Route): string | null {
  if (route.page === 'essay') return route.id
  if (route.page === 'repo') return route.noteId ?? route.repo
  return null
}

/**
 * 一覧を持つ画面（Essay の全部か、1 つの Repo）の Note の作成・削除・取り消し・title・status・Star。
 * 中継の route で editor は作り直すが、取り消しの stack はこの画面にいる間ずっと持つ。
 */
export class ListedNotes {
  #screen: ListedScreen
  #deps: ListedNotesDeps
  #removals: Removals
  #open: OpenNote | null = null
  #unsubscribeOpen: (() => void) | null = null
  #detachOpen: (() => void) | null = null
  #attached = false
  #titleFocusId: string | null = null
  #tab: EssayStatus = 'writing'
  #synced: { key: string | null; status: EssayStatus | null } = { key: null, status: null }
  // 一覧の取り直しが Essay の取り直しより先に返ると、外で消された Essay は並びから消えている。
  #lastShown: { id: string; tab: EssayStatus; ids: string[] } | null = null
  #goneSettled: string | null = null
  #view: ListedNotesView = { open: emptyView(null, 0), titleFocusId: null, tab: 'writing' }
  #listeners = new Set<() => void>()

  /** 押すたびに Backend の Star を読んでから逆を送る。並びは Backend が決めるので一覧は取り直す。 */
  toggleStar: (id: string) => Promise<void>

  constructor(screen: ListedScreen, deps: ListedNotesDeps) {
    this.#screen = screen
    this.#deps = deps
    const { client, saves, queryClient } = deps
    this.#removals = new Removals(screen.kind, {
      flush: saves.flush,
      hasUnsaved: saves.hasUnsaved,
      remove: (id) => client.remove({ id }),
      restore: (id) => client.restore({ id }),
      discard: saves.discard,
      forgetBody: (id) => queryClient.removeQueries({ queryKey: queryKeys.note(id), exact: true }),
      openId: () => openNoteIdOfPath(deps.pathname()),
    })
    this.toggleStar = createStarToggle({
      read: (id) => client.get({ id }).then((note) => 'starred' in note && note.starred),
      send: (id, starred) => client.star({ id, starred }),
      invalidate: () => this.#invalidateList(),
    })
  }

  get kind(): ListedScreen['kind'] {
    return this.#screen.kind
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  view = (): ListedNotesView => this.#view

  attach = (): (() => void) => {
    this.#attached = true
    this.#detachOpen = this.#open?.attach() ?? null
    const unsubscribeList = this.#deps.queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.query.queryKey[0] === 'essays') this.#remember()
    })
    return () => {
      this.#attached = false
      this.#detachOpen?.()
      this.#detachOpen = null
      unsubscribeList()
    }
  }

  /** route の Note を editor に開く。一覧と中継の route では editor を外し、取り消しの stack は残す。 */
  present = (route: Route): void => {
    const key = openKeyOf(route)
    if (key === null) {
      this.#dropOpen()
      return
    }
    const open = this.#open ?? this.#makeOpen()
    if (route.page === 'repo') {
      const { repo, noteId } = route
      this.#screen = { kind: 'repo_note', repo }
      open.open(
        key,
        noteId === null ? scratchQueryOptions(this.#deps.client, repo) : this.#noteQuery(noteId),
        (fetched) => noteId === null || repoNoteRedirect(repo, fetched) === null,
      )
    } else {
      open.open(key, this.#noteQuery(key))
    }
  }

  /** Open Note がこの一覧の Note ならその id。Scratch と別の種類の Note は null で、キーを editor に渡す。 */
  listedOpenId = (): string | null => {
    const note = this.#open?.editing ?? null
    return note?.kind === this.#screen.kind ? note.id : null
  }

  create = async (): Promise<void> => {
    await this.#deps.saves.flush()
    let created: Note
    try {
      created = await this.#createNote()
    } catch {
      // 作れなくても次の ⌥N で作り直せる。
      return
    }
    // 先に cache へ置いてから移ると、loading を挟まずに描ける。
    this.#seed(created)
    this.#titleFocusId = created.id
    this.#publish()
    this.#deps.navigate(this.#pathOf(created.id))
    this.#invalidateList()
  }

  remove = async (id: string): Promise<void> => {
    const leave = () => this.#leave(id)
    const removed =
      this.#open === null
        ? await this.#removals.remove(id, { leave })
        : await this.#open.remove(id, this.#removals, leave)
    // 移り先は消す前の並びから選ぶので、一覧から外すのは移った後にする。
    if (removed) this.#editRows((row) => (row.id === id ? null : row))
  }

  undo = async (): Promise<void> => {
    // 一覧の画面で戻した Note は開かず、一覧に並べ直すだけにする。
    const fromEditor = openKeyOf(routeOf(this.#deps.pathname())) !== null
    const restored = await this.#removals.undo()
    if (restored === null) return
    // 戻した Note の preview まで正しく並べ直すため、繕わずに取り直す。
    this.#invalidateList()
    this.#seed(restored)
    if (fromEditor) this.#deps.navigate(this.#pathOf(restored.id))
  }

  changeBody = (doc: unknown): void => {
    this.#open?.changeBody(doc)
  }

  changeTitle = (title: string): void => {
    const next = this.#open?.changeTitle(title) ?? null
    if (next !== null) this.#editRows(patchRow(next.id, { title }))
  }

  reload = async (): Promise<void> => {
    await this.#open?.reload()
  }

  toggleEssayStatus = async (): Promise<void> => {
    const open = this.#open
    if (open === null) return
    try {
      // 返った版で一覧を直す。待つ間に別の Note へ移ると、Open Note は結果を画面に出さない。
      const updated = await open.toggleStatus()
      if (updated?.kind === 'essay')
        this.#editRows(patchRow(updated.id, { status: updated.status }))
    } catch {
      // 手元の一覧が古いだけなので、取り直せば追いつく。
      this.#invalidateList()
    }
  }

  /** 一覧の右クリックから、見えている status の次を送る。開いていない Essay なので Base Version は動かさない。 */
  setEssayStatus = async (id: string, status: EssayStatus): Promise<void> => {
    try {
      const updated = await this.#deps.client.essay.setStatus({ id, status })
      if (updated.kind === 'essay') this.#editRows(patchRow(updated.id, { status: updated.status }))
    } catch {
      this.#invalidateList()
    }
  }

  setEssayTab = (tab: EssayStatus): void => {
    this.#tab = tab
    this.#remember()
    this.#publish()
  }

  releaseTitleFocus = (): void => {
    if (this.#titleFocusId === null) return
    this.#titleFocusId = null
    this.#publish()
  }

  #makeOpen(): OpenNote {
    const { queryClient, saves, client, showOpen, pathname } = this.#deps
    const open = new OpenNote({
      queryClient,
      saves,
      client,
      showOpen,
      openId: () => openNoteIdOfPath(pathname()),
    })
    this.#open = open
    this.#tab = 'writing'
    this.#synced = { key: null, status: null }
    this.#goneSettled = null
    this.#unsubscribeOpen = open.subscribe(() => this.#onOpen(open))
    if (this.#attached) this.#detachOpen = open.attach()
    return open
  }

  #dropOpen(): void {
    if (this.#open === null) return
    this.#detachOpen?.()
    this.#detachOpen = null
    this.#unsubscribeOpen?.()
    this.#unsubscribeOpen = null
    this.#open = null
    this.#titleFocusId = null
    this.#lastShown = null
    this.#publish()
  }

  #onOpen(open: OpenNote): void {
    const { key, note, gone } = open.view()
    const status = note?.kind === 'essay' ? note.status : null
    if (key !== this.#synced.key || status !== this.#synced.status) {
      // タブを開いた Essay の status へ移すのは、開いた時と status が変わった時だけ。常に合わせると ⌥H/⌥L で移した瞬間に引き戻される。
      this.#synced = { key, status }
      if (status !== null) this.#tab = status
    }
    this.#remember()
    this.#settleGone(open, gone)
    this.#publish()
  }

  #settleGone(open: OpenNote, gone: string | null): void {
    if (gone === this.#goneSettled) return
    this.#goneSettled = gone
    if (gone === null) return
    // TanStack Query が observer へ結果を配っている間は、その cache を消さず URL も動かさない。
    queueMicrotask(() => {
      if (!this.#attached || this.#open !== open) return
      this.#removals.removedElsewhere(gone, { leave: () => this.#leave(gone) })
      this.#editRows((row) => (row.id === gone ? null : row))
    })
  }

  #remember(): void {
    const id = this.#open?.view().key ?? null
    if (this.#screen.kind !== 'essay' || id === null) return
    const ids = this.#shownEssayIds()
    if (ids.includes(id)) this.#lastShown = { id, tab: this.#tab, ids }
  }

  #shownEssayIds(): string[] {
    const list = this.#deps.queryClient.getQueryData<EssaySummary[]>(queryKeys.essays()) ?? []
    return list.filter((essay) => essay.status === this.#tab).map((essay) => essay.id)
  }

  #leave(id: string): void {
    const { navigate } = this.#deps
    if (this.#screen.kind === 'repo_note') {
      // Repo には必ず Scratch がある。
      navigate(repoPath(this.#screen.repo), { replace: true })
      return
    }
    const shown = this.#shownEssayIds()
    const last = this.#lastShown
    const ids = !shown.includes(id) && last?.id === id && last.tab === this.#tab ? last.ids : shown
    // 表示中のタブにあった Essay はタブの次へ送って書く流れを切らない。タブの外の Essay は送り先が見えていないので一覧へ帰す。
    const next = ids.includes(id) ? cycleSelect(ids, id, 1) : undefined
    navigate(next !== undefined && next !== id ? essayPath(next) : ESSAYS_PATH, { replace: true })
  }

  #noteQuery(id: string): NoteQueryOptions {
    return noteQueryOptions(this.#deps.client, id)
  }

  #createNote(): Promise<Note> {
    const { client } = this.#deps
    switch (this.#screen.kind) {
      case 'essay':
        return client.essay.create()
      case 'repo_note':
        return client.repoNote.create({ repo: this.#screen.repo })
    }
  }

  #pathOf(id: string): string {
    switch (this.#screen.kind) {
      case 'essay':
        return essayPath(id)
      case 'repo_note':
        return repoNotePath(this.#screen.repo, id)
    }
  }

  #listKey() {
    switch (this.#screen.kind) {
      case 'essay':
        return queryKeys.essays()
      case 'repo_note':
        return queryKeys.repoNotes(this.#screen.repo)
    }
  }

  #seed(note: Note): void {
    this.#deps.queryClient.setQueryData(queryKeys.note(note.id), note)
  }

  #invalidateList(): void {
    void this.#deps.queryClient.invalidateQueries({ queryKey: this.#listKey() })
  }

  #editRows(edit: RowEdit): void {
    const { queryClient } = this.#deps
    switch (this.#screen.kind) {
      case 'essay':
        queryClient.setQueryData<EssaySummary[]>(
          queryKeys.essays(),
          (list) => list && editRows(list, edit),
        )
        return
      case 'repo_note':
        // 頁と cursor の形を保ったまま、行だけを書き換える。
        queryClient.setQueryData<RepoNotesData>(queryKeys.repoNotes(this.#screen.repo), (data) => {
          if (data === undefined) return data
          const pages = data.pages.map((page) => {
            const notes = editRows(page.notes, edit)
            return notes === page.notes ? page : { ...page, notes }
          })
          return pages.every((page, i) => page === data.pages[i]) ? data : { ...data, pages }
        })
    }
  }

  #publish(): void {
    this.#view = {
      open: this.#open?.view() ?? emptyView(null, 0),
      titleFocusId: this.#titleFocusId,
      tab: this.#tab,
    }
    for (const listener of this.#listeners) listener()
  }
}

/** 何も変えない行は同じ参照のまま返し、取り直しや描き直しを起こさない。 */
function editRows<T extends EssaySummary | RepoNoteSummary>(rows: T[], edit: RowEdit): T[] {
  let changed = false
  const next: T[] = []
  for (const row of rows) {
    const edited = edit(row)
    if (edited !== row) changed = true
    if (edited !== null) next.push(edited)
  }
  return changed ? next : rows
}

function patchRow(id: string, fields: { title?: string; status?: EssayStatus }): RowEdit {
  return (row) => {
    if (row.id !== id) return row
    const titled = fields.title === undefined || fields.title === row.title
    const statused =
      fields.status === undefined || ('status' in row && fields.status === row.status)
    return titled && statused ? row : { ...row, ...fields }
  }
}
