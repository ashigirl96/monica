import { describe, expect, test } from 'bun:test'

import type { Note } from '../contract.ts'
import { notePagePath, routeOf, todayPath } from './routes.ts'

const now = new Date(2026, 9, 6, 12)

describe('routeOf', () => {
  test('the root, /notes and /daily open the Daily of today', () => {
    for (const path of ['/', '/notes', '/notes/', '/daily', '/daily/']) {
      expect(routeOf(path)).toEqual({ page: 'today' })
    }
  })

  test('/daily/:date opens the Daily of that date, and /notes/:id finds the screen of the Note', () => {
    expect(routeOf('/daily/2099-01-01')).toEqual({ page: 'daily', date: '2099-01-01' })
    expect(routeOf('/notes/note-7')).toEqual({ page: 'note', id: 'note-7' })
  })

  test('/essays opens the list of Essays, and /essays/:id the Essay', () => {
    for (const path of ['/essays', '/essays/']) expect(routeOf(path)).toEqual({ page: 'essays' })
    expect(routeOf('/essays/note-7')).toEqual({ page: 'essay', id: 'note-7' })
  })

  test('any other path is not found', () => {
    for (const path of ['/essays/note-7/x', '/repos/a/b', '/daily/2026-10-06/x', '/settings']) {
      expect(routeOf(path)).toEqual({ page: 'not-found' })
    }
  })
})

test("today is the Logical Date of the moment it is asked, the day before when it is before 5 o'clock", () => {
  expect(todayPath(new Date(2026, 9, 6, 4, 59))).toBe('/daily/2026-10-05')
  expect(todayPath(new Date(2026, 9, 6, 5, 0))).toBe('/daily/2026-10-06')
})

describe('notePagePath', () => {
  const common = {
    id: 'note-7',
    date: '2026-10-06',
    content: { type: 'doc' as const },
    createdAt: now,
    updatedAt: now,
  }

  test('a Daily opens at the path of the date it is for, even one ahead of the day it was made', () => {
    expect(notePagePath({ kind: 'daily', ...common, date: '2099-01-01' })).toBe('/daily/2099-01-01')
  })

  test('an Essay opens at the path of its id', () => {
    expect(notePagePath({ kind: 'essay', title: 'On Rust', status: 'writing', ...common })).toBe(
      '/essays/note-7',
    )
  })

  test('a Note of a kind with no screen yet has no path', () => {
    const others: Note[] = [
      { kind: 'repo_note', repo: 'a/b', title: 'Spec', ...common },
      { kind: 'scratch', repo: 'a/b', ...common },
    ]
    for (const note of others) expect(notePagePath(note)).toBeNull()
  })
})
