/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'

import type { Note, NoteSummary } from '../../contract.ts'
import { noteLabel, summaryTitle } from './summary.ts'

type Kind =
  | { kind: 'daily' }
  | { kind: 'essay'; title: string; status: 'writing' | 'finished' }
  | { kind: 'repo_note'; repo: string; title: string }
  | { kind: 'scratch'; repo: string }

function note(kind: Kind): Note {
  return {
    id: 'note-1',
    ...kind,
    content: { type: 'doc', content: [] },
    date: '2026-08-29',
    createdAt: new Date('2026-08-29T10:00:00.000Z'),
    updatedAt: new Date('2026-08-29T10:00:00.000Z'),
  }
}

describe('noteLabel', () => {
  test('essay は非空 title を使う', () => {
    expect(
      noteLabel(note({ kind: 'essay', title: 'On Rust', status: 'writing' }), 'Untitled'),
    ).toBe('On Rust')
  })

  test('essay の無題は fallback', () => {
    expect(noteLabel(note({ kind: 'essay', title: '', status: 'writing' }), 'Untitled')).toBe(
      'Untitled',
    )
  })

  test('repo note は非空 title を使い、無題は fallback', () => {
    expect(noteLabel(note({ kind: 'repo_note', repo: 'a/b', title: 'Spec' }), 'a/b')).toBe('Spec')
    expect(noteLabel(note({ kind: 'repo_note', repo: 'a/b', title: '' }), 'a/b')).toBe('a/b')
  })

  test('daily は title を持たないので常に fallback', () => {
    expect(noteLabel(note({ kind: 'daily' }), 'Sat 8.29')).toBe('Sat 8.29')
  })
})

function summary(title: string, preview: string | null): NoteSummary {
  const at = new Date('2026-08-29T10:00:00.000Z')
  return {
    kind: 'essay',
    id: 'note-1',
    title,
    status: 'writing',
    date: '2026-08-29',
    preview,
    createdAt: at,
    updatedAt: at,
  }
}

describe('summaryTitle', () => {
  test('非空 title があれば preview より title を使う', () => {
    expect(summaryTitle(summary('On Rust', 'first line'))).toBe('On Rust')
  })

  test('無題は preview を、preview も無ければ Untitled を使う', () => {
    expect(summaryTitle(summary('', 'first line'))).toBe('first line')
    expect(summaryTitle(summary('', null))).toBe('Untitled')
  })
})
