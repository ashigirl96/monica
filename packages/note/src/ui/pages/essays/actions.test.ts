import { describe, expect, test } from 'bun:test'

import type { EssayStatus, Note } from '../../../contract.ts'
import { type Gate, removeEssay, removeOpenEssay, setOpenEssayStatus } from './actions.ts'

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

function removal(gate: Gate, overrides: Partial<Parameters<typeof removeOpenEssay>[0]> = {}) {
  const calls = { removed: [] as string[], rescheduled: [] as string[] }
  const run = removeOpenEssay({
    gate,
    isOpen: () => true,
    flush: async () => {},
    hasUnsaved: () => false,
    remove: async (id) => {
      calls.removed.push(id)
    },
    reschedule: (note) => calls.rescheduled.push(note.id),
    ...overrides,
  })
  return { run, calls }
}

describe('removeEssay', () => {
  test('removes the Essay once its pending edit is saved, and keeps it while an edit is left unsaved', async () => {
    const removed: string[] = []
    const remove = async (id: string) => {
      removed.push(id)
    }
    const save = slowSave()
    const saved = removeEssay({ id: 'note-1', ...save, remove })
    await Bun.sleep(0)
    expect(removed).toEqual([])
    save.settle()

    expect(await saved).toBe(true)
    expect(
      await removeEssay({ id: 'note-2', flush: async () => {}, hasUnsaved: () => true, remove }),
    ).toBe(false)
    expect(removed).toEqual(['note-1'])
  })
})

describe('removeOpenEssay', () => {
  test('flushes before removing, and stops saving the Essay while waiting', async () => {
    const gate: Gate = { current: essay('note-1') }
    const seen: (Note | null)[] = []
    const { run, calls } = removal(gate, {
      flush: async () => {
        seen.push(gate.current)
      },
    })

    expect((await run)?.id).toBe('note-1')
    expect(seen).toEqual([null])
    expect(calls.removed).toEqual(['note-1'])
    expect(gate.current).toBeNull()
  })

  test('waits for the pending edit to be saved, then removes the Essay', async () => {
    const save = slowSave()
    const { run, calls } = removal(
      { current: essay('note-1') },
      { flush: save.flush, hasUnsaved: save.hasUnsaved },
    )
    await Bun.sleep(0)
    expect(calls.removed).toEqual([])

    save.settle()

    expect((await run)?.id).toBe('note-1')
    expect(calls.removed).toEqual(['note-1'])
  })

  test('keeps the Essay and saves it again when an edit is left unsaved after flushing', async () => {
    const open = essay('note-1')
    const gate: Gate = { current: open }
    const { run, calls } = removal(gate, { hasUnsaved: () => true })

    expect(await run).toBeNull()
    expect(calls.removed).toEqual([])
    expect(gate.current).toBe(open)
    expect(calls.rescheduled).toEqual(['note-1'])
  })

  test('keeps the Essay when the deletion fails', async () => {
    const open = essay('note-1')
    const gate: Gate = { current: open }
    const { run, calls } = removal(gate, {
      remove: async () => {
        throw new Error('offline')
      },
    })

    expect(await run).toBeNull()
    expect(gate.current).toBe(open)
    expect(calls.rescheduled).toEqual(['note-1'])
  })

  test('does not hand the screen back to the Essay when another Note was opened while waiting', async () => {
    const gate: Gate = { current: essay('note-1') }
    let open = 'note-1'
    const { run, calls } = removal(gate, {
      isOpen: (id) => id === open,
      flush: async () => {
        open = 'note-2'
      },
      hasUnsaved: () => true,
    })

    expect(await run).toBeNull()
    expect(gate.current).toBeNull()
    expect(calls.rescheduled).toEqual([])
  })

  test('leaves a Note of another kind that was opened by its id', async () => {
    const repoNote: Note = {
      kind: 'repo_note',
      id: 'note-1',
      repo: 'acme/app',
      title: 'Plan',
      date: '2026-10-07',
      content: { type: 'doc' },
      createdAt: before,
      updatedAt: before,
    }
    const gate: Gate = { current: repoNote }
    const { run, calls } = removal(gate)

    expect(await run).toBeNull()
    expect(calls.removed).toEqual([])
    expect(gate.current).toBe(repoNote)
  })

  test('leaves a Note that was taken up while waiting', async () => {
    const other = essay('note-2')
    const gate: Gate = { current: essay('note-1') }
    const { run, calls } = removal(gate, {
      flush: async () => {
        gate.current = other
      },
      hasUnsaved: () => true,
    })

    expect(await run).toBeNull()
    expect(gate.current).toBe(other)
    expect(calls.rescheduled).toEqual([])
  })
})

function statusChange(gate: Gate, overrides: Partial<Parameters<typeof setOpenEssayStatus>[0]>) {
  const calls = {
    sent: [] as [string, EssayStatus][],
    bases: [] as [string, Date][],
    adopted: [] as Note[],
    patched: [] as EssayStatus[],
  }
  const run = setOpenEssayStatus({
    targetId: 'note-1',
    gate,
    flush: async () => {},
    hasUnsaved: () => false,
    setStatus: async (id, status) => {
      calls.sent.push([id, status])
      return essay(id, status, after)
    },
    setBase: (id, updatedAt) => calls.bases.push([id, updatedAt]),
    adopt: (note) => calls.adopted.push(note),
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
      expect(calls.adopted).toEqual([essay('note-1', to, after)])
      expect(calls.patched).toEqual([])
    }
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
