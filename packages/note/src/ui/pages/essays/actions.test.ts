import { describe, expect, test } from 'bun:test'

import type { EssayStatus, Note } from '../../../contract.ts'
import { type Gate, setOpenEssayStatus } from './actions.ts'

const before = new Date('2026-10-07T10:00:00.000Z')
const after = new Date('2026-10-07T10:00:01.000Z')

function essay(id: string, status: EssayStatus = 'writing', updatedAt = before): Note {
  return {
    kind: 'essay',
    id,
    title: 'On ledgers',
    status,
    date: '2026-10-07',
    content: { type: 'doc' },
    createdAt: before,
    updatedAt,
  }
}

/** 保存が返るまで flush を止め、返った後にだけ未保存が無くなる autosave。 */
function slowSave() {
  let unsaved = true
  const flushed = Promise.withResolvers<void>()
  return {
    flush: () => flushed.promise,
    hasUnsaved: () => unsaved,
    settle: () => {
      unsaved = false
      flushed.resolve()
    },
  }
}

function statusChange(gate: Gate, overrides: Partial<Parameters<typeof setOpenEssayStatus>[0]>) {
  const calls = {
    sent: [] as [string, EssayStatus][],
    bases: [] as [string, Date][],
    adopted: [] as [Note, boolean][],
    patched: [] as EssayStatus[],
  }
  const run = setOpenEssayStatus({
    targetId: 'note-1',
    gate,
    shownContent: () => ({ type: 'doc' }),
    flush: async () => {},
    hasUnsaved: () => false,
    setStatus: async (id, status) => {
      calls.sent.push([id, status])
      return essay(id, status, after)
    },
    setBase: (id, updatedAt) => calls.bases.push([id, updatedAt]),
    adopt: (note, remount) => calls.adopted.push([note, remount]),
    patchStatus: (status) => calls.patched.push(status),
    ...overrides,
  })
  return { run, calls }
}

describe('setOpenEssayStatus', () => {
  test('sends the status after the one it has, bases the next save on the new version and shows the Essay it gets back', async () => {
    for (const [from, to] of [
      ['writing', 'finished'],
      ['finished', 'writing'],
    ] as const) {
      const { run, calls } = statusChange({ current: essay('note-1', from) }, {})

      expect(await run).toMatchObject({ status: to })
      expect(calls.sent).toEqual([['note-1', to]])
      expect(calls.bases).toEqual([['note-1', after]])
      expect(calls.adopted).toEqual([[essay('note-1', to, after), false]])
      expect(calls.patched).toEqual([])
    }
  })

  test('shows the body and title it gets back when they were changed elsewhere', async () => {
    for (const changed of [
      { content: { type: 'doc' as const, content: [{ type: 'paragraph' }] } },
      { title: 'Retitled' },
    ]) {
      const updated = { ...essay('note-1', 'finished', after), ...changed }
      const { run, calls } = statusChange(
        { current: essay('note-1') },
        {
          setStatus: async () => updated,
        },
      )

      expect(await run).toBe(updated)
      expect(calls.adopted).toEqual([[updated, true]])
      expect(calls.patched).toEqual([])
    }
  })

  test('keeps the version it had when the Essay was changed elsewhere and an edit was made while the status was being set', async () => {
    let typed = false
    const { run, calls } = statusChange(
      { current: essay('note-1') },
      {
        hasUnsaved: () => typed,
        setStatus: async (id, status) => {
          typed = true
          return { ...essay(id, status, after), title: 'Retitled' }
        },
      },
    )

    expect(await run).toMatchObject({ status: 'finished' })
    expect(calls.bases).toEqual([])
    expect(calls.adopted).toEqual([])
    expect(calls.patched).toEqual(['finished'])
  })

  test('waits for the pending edit to be saved, then sets the status', async () => {
    const save = slowSave()
    const { run, calls } = statusChange(
      { current: essay('note-1') },
      { flush: save.flush, hasUnsaved: save.hasUnsaved },
    )
    await Bun.sleep(0)
    expect(calls.sent).toEqual([])

    save.settle()

    expect(await run).toMatchObject({ status: 'finished' })
    expect(calls.sent).toEqual([['note-1', 'finished']])
  })

  test('leaves the status when an edit is left unsaved after flushing', async () => {
    const { run, calls } = statusChange({ current: essay('note-1') }, { hasUnsaved: () => true })

    expect(await run).toBeNull()
    expect(calls.sent).toEqual([])
    expect(calls.bases).toEqual([])
  })

  test('takes only the status when an edit was made while it was being set', async () => {
    let typed = false
    const { run, calls } = statusChange(
      { current: essay('note-1') },
      {
        hasUnsaved: () => typed,
        setStatus: async (id, status) => {
          typed = true
          return essay(id, status, after)
        },
      },
    )

    expect(await run).toMatchObject({ status: 'finished' })
    expect(calls.bases).toEqual([['note-1', after]])
    expect(calls.adopted).toEqual([])
    expect(calls.patched).toEqual(['finished'])
  })

  test('leaves the screen alone when another Note was opened while it was being set', async () => {
    const gate: Gate = { current: essay('note-1') }
    const { run, calls } = statusChange(gate, {
      setStatus: async (id, status) => {
        gate.current = essay('note-2')
        return essay(id, status, after)
      },
    })

    expect(await run).toMatchObject({ id: 'note-1', status: 'finished' })
    expect(calls.bases).toEqual([['note-1', after]])
    expect(calls.adopted).toEqual([])
    expect(calls.patched).toEqual([])
  })

  test('does nothing when the Essay it was asked for is no longer open', async () => {
    for (const current of [null, essay('note-2')]) {
      const { run, calls } = statusChange({ current }, {})

      expect(await run).toBeNull()
      expect(calls.sent).toEqual([])
    }
  })
})
