import { describe, expect, test } from 'bun:test'

import type { Note } from '../contract.ts'
import {
  notePagePath,
  openNoteIdOfPath,
  removalScreenOf,
  repoNoteRedirect,
  routeOf,
  sameRemovalScreen,
  todayPath,
} from './routes.ts'

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

  test('/repos opens the last Repo, /repos/:owner/:repo its Scratch, and a Repo Note is under its notes', () => {
    expect(routeOf('/repos')).toEqual({ page: 'repos' })
    expect(routeOf('/repos/')).toEqual({ page: 'repos' })
    expect(routeOf('/repos/acme/app.js')).toEqual({
      page: 'repo',
      repo: 'acme/app.js',
      noteId: null,
    })
    expect(routeOf('/repos/acme/app/notes/note-7')).toEqual({
      page: 'repo',
      repo: 'acme/app',
      noteId: 'note-7',
    })
  })

  test('any other path is not found', () => {
    for (const path of [
      '/essays/note-7/x',
      '/repos/acme',
      '/repos/acme/app/x',
      '/repos/acme/app/notes',
      '/daily/2026-10-06/x',
      '/settings',
    ]) {
      expect(routeOf(path)).toEqual({ page: 'not-found' })
    }
  })
})

test('the open Note is the Essay or Repo Note the path names', () => {
  expect(openNoteIdOfPath('/essays/note-7')).toBe('note-7')
  expect(openNoteIdOfPath('/repos/acme/app/notes/note-7')).toBe('note-7')
  for (const path of ['/essays', '/repos/acme/app', '/daily/2026-10-06', '/notes/note-7']) {
    expect(openNoteIdOfPath(path)).toBeNull()
  }
})

describe('removalScreenOf', () => {
  const essays = { kind: 'essay' } as const
  const repo = { kind: 'repo_note', repo: 'acme/app' } as const

  test('the list and the editor of Essays are one screen', () => {
    expect(removalScreenOf(routeOf('/essays'), null)).toEqual(essays)
    expect(removalScreenOf(routeOf('/essays/note-7'), null)).toEqual(essays)
    expect(sameRemovalScreen(removalScreenOf(routeOf('/essays/note-7'), essays), essays)).toBe(true)
  })

  test('each Repo is its own screen, whether its Scratch or a Repo Note is open', () => {
    expect(removalScreenOf(routeOf('/repos/acme/app'), null)).toEqual(repo)
    const onNote = removalScreenOf(routeOf('/repos/acme/app/notes/note-7'), repo)
    expect(sameRemovalScreen(onNote, repo)).toBe(true)
    const other = removalScreenOf(routeOf('/repos/acme/web'), repo)
    expect(sameRemovalScreen(other, repo)).toBe(false)
  })

  test('a Repo spelled with other cases in the path is the same screen', () => {
    const upper = removalScreenOf(routeOf('/repos/Acme/App/notes/note-7'), repo)
    expect(sameRemovalScreen(upper, repo)).toBe(true)
  })

  test('/notes/:id and /repos pass through, staying on the screen before them', () => {
    for (const previous of [essays, repo, null]) {
      expect(removalScreenOf(routeOf('/notes/note-7'), previous)).toBe(previous)
      expect(removalScreenOf(routeOf('/repos'), previous)).toBe(previous)
    }
  })

  test('the Daily, today and an unknown path are screens without undo', () => {
    for (const path of ['/daily/2026-10-06', '/daily', '/settings']) {
      expect(removalScreenOf(routeOf(path), essays)).toBeNull()
      expect(removalScreenOf(routeOf(path), repo)).toBeNull()
    }
  })

  test('the Essays and a Repo are different screens, and no screen is none of them', () => {
    expect(sameRemovalScreen(essays, repo)).toBe(false)
    expect(sameRemovalScreen(essays, null)).toBe(false)
    expect(sameRemovalScreen(null, repo)).toBe(false)
    expect(sameRemovalScreen(null, null)).toBe(true)
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

  test('a Scratch opens at the path of its Repo, and a Repo Note under the notes of its Repo', () => {
    expect(notePagePath({ kind: 'scratch', repo: 'acme/app', ...common })).toBe('/repos/acme/app')
    expect(notePagePath({ kind: 'repo_note', repo: 'acme/app', title: 'Spec', ...common })).toBe(
      '/repos/acme/app/notes/note-7',
    )
  })
})

describe('repoNoteRedirect', () => {
  const common = {
    id: 'note-7',
    date: '2026-10-06',
    content: { type: 'doc' as const },
    createdAt: now,
    updatedAt: now,
  }

  test('a Repo Note of the Repo stays, whatever the case of the Repo in the path', () => {
    const note: Note = { kind: 'repo_note', repo: 'acme/app', title: 'Spec', ...common }
    expect(repoNoteRedirect('Acme/App', note)).toBeNull()
  })

  test('the Scratch of the Repo goes to the path of the Repo, as it is spelled in the path', () => {
    expect(repoNoteRedirect('Acme/App', { kind: 'scratch', repo: 'acme/app', ...common })).toBe(
      '/repos/Acme/App',
    )
  })

  test('a Note of another Repo or another kind goes to its own path', () => {
    const others: [Note, string][] = [
      [
        { kind: 'repo_note', repo: 'acme/web', title: 'Spec', ...common },
        '/repos/acme/web/notes/note-7',
      ],
      [{ kind: 'scratch', repo: 'acme/web', ...common }, '/repos/acme/web'],
      [{ kind: 'daily', ...common }, '/daily/2026-10-06'],
      [{ kind: 'essay', title: 'On Rust', status: 'writing', ...common }, '/essays/note-7'],
    ]
    for (const [note, path] of others) expect(repoNoteRedirect('acme/app', note)).toBe(path)
  })
})
