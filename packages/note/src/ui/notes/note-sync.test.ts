/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test'

import type { Note } from '../../contract.ts'
import { noteToOpen, reloadLatest, shouldAdoptServerDoc, usableServerDoc } from './note-sync.ts'

const V1 = new Date('2026-08-29T10:00:00.000Z')
const V2 = new Date('2026-08-29T10:00:00.001Z')
const V3 = new Date('2026-08-29T10:00:00.002Z')

function note(updatedAt: Date): Note {
  return {
    id: 'note-1',
    kind: 'daily',
    content: { type: 'doc', content: [] },
    date: '2026-08-29',
    createdAt: V1,
    updatedAt,
  }
}

describe('shouldAdoptServerDoc', () => {
  test('外部が書いた新しい版は差し替える', () => {
    expect(
      shouldAdoptServerDoc({ fetchedUpdatedAt: V3, baseUpdatedAt: V2, hasUnsaved: false }),
    ).toBe(true)
  })

  test('自分が書いた版と同じなら差し替えない（打鍵中の再マウントを避ける）', () => {
    expect(
      shouldAdoptServerDoc({
        fetchedUpdatedAt: new Date(V2),
        baseUpdatedAt: V2,
        hasUnsaved: false,
      }),
    ).toBe(false)
  })

  test('保存中の再フェッチが掴んだ書き込み前の doc は差し戻さない', () => {
    expect(
      shouldAdoptServerDoc({ fetchedUpdatedAt: V1, baseUpdatedAt: V2, hasUnsaved: false }),
    ).toBe(false)
  })

  test('未保存の編集があるうちは差し替えない（競合は CONFLICT が拾う）', () => {
    expect(
      shouldAdoptServerDoc({ fetchedUpdatedAt: V3, baseUpdatedAt: V2, hasUnsaved: true }),
    ).toBe(false)
  })

  test('初回ロードは mount がそのまま反映するので世代を進めない', () => {
    expect(
      shouldAdoptServerDoc({ fetchedUpdatedAt: V2, baseUpdatedAt: null, hasUnsaved: false }),
    ).toBe(false)
  })
})

describe('usableServerDoc', () => {
  test('基準版が無ければそのまま採用できる', () => {
    expect(usableServerDoc(note(V1), null)).not.toBeNull()
  })

  test('自分が保存した直後の 1 世代古い cache は採用しない', () => {
    // 保存は doc を返さないので cache は V1 のまま、台帳は V2 に進んでいる状態
    expect(usableServerDoc(note(V1), V2)).toBeNull()
  })

  test('基準版と同じ版は採用できる', () => {
    expect(usableServerDoc(note(new Date(V2)), V2)).not.toBeNull()
  })

  test('基準版より新しい版は採用できる', () => {
    expect(usableServerDoc(note(V3), V2)).not.toBeNull()
  })

  test('未取得（undefined）は採用しない', () => {
    expect(usableServerDoc(undefined, null)).toBeNull()
  })
})

function reloadSetup(
  result: { data?: Note; isError: boolean },
  whileFetching: 'edit' | 'move' | null = null,
) {
  const steps: string[] = []
  let mark = 0
  let open = true
  const dropPending = mock((id: string) => void steps.push(`drop ${id}`))
  const adopt = mock((next: Note) => void steps.push(`adopt ${next.updatedAt.getTime()}`))
  const refetch = () => {
    if (whileFetching === 'edit') mark += 1
    if (whileFetching === 'move') open = false
    return Promise.resolve(result)
  }
  const editMark = () => mark
  const isOpen = () => open
  return {
    steps,
    run: () => reloadLatest({ id: 'note-1', refetch, dropPending, adopt, editMark, isOpen }),
  }
}

describe('reloadLatest', () => {
  test('取り直しが失敗したら、古い cache が返っても手元の編集と競合を捨てず、採用もしない', async () => {
    const { steps, run } = reloadSetup({ data: note(V1), isError: true })
    await run()
    expect(steps).toEqual([])
  })

  test('取り直しが通ったら、手元の編集を捨ててから取り直した doc を採用する', async () => {
    const { steps, run } = reloadSetup({ data: note(V3), isError: false })
    await run()
    expect(steps).toEqual(['drop note-1', `adopt ${V3.getTime()}`])
  })

  test('取り直しの間に別の note へ移ったら、取り直した doc を今の画面に採用しない', async () => {
    const { steps, run } = reloadSetup({ data: note(V3), isError: false }, 'move')
    await run()
    expect(steps).toEqual([])
  })

  test('取り直しの間に書いた編集があれば、捨てずに競合のまま残す', async () => {
    const { steps, run } = reloadSetup({ data: note(V3), isError: false }, 'edit')
    await run()
    expect(steps).toEqual([])
  })
})

describe('noteToOpen', () => {
  const edited = { type: 'doc' as const, content: [{ type: 'text', text: 'unsaved' }] }

  test('未保存の編集がある note を開き直したら、cache の本文ではなくその編集を出す', () => {
    expect(noteToOpen(note(V2), V2, { content: edited })).toEqual({
      ...note(V2),
      content: edited,
    })
  })

  test('未保存の title も、cache の title ではなくその編集を出す', () => {
    const essay: Note = { ...note(V2), kind: 'essay', title: 'Saved', status: 'writing' }

    expect(noteToOpen(essay, V2, { content: edited, title: 'Unsaved' })).toEqual({
      ...essay,
      content: edited,
      title: 'Unsaved',
    })
  })

  test('cache が基準版より古くても、未保存の編集があればそれで開く', () => {
    expect(noteToOpen(note(V1), V2, { content: edited })).toEqual({
      ...note(V1),
      content: edited,
      updatedAt: V2,
    })
  })

  test('cache に外から新しい版が入っていても、未保存の編集は基準版のまま開き、競合を保存に拾わせる', () => {
    expect(noteToOpen(note(V3), V2, { content: edited })?.updatedAt).toEqual(V2)
  })

  test('未保存の編集が無ければ、使える cache をそのまま開き、1 世代古い cache では開かない', () => {
    expect(noteToOpen(note(V2), V2, null)).toEqual(note(V2))
    expect(noteToOpen(note(V1), V2, null)).toBeNull()
  })
})
