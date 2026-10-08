/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'

import type { EssayStatus, EssaySummary, NoteSummary } from '../../../contract.ts'
import { ESSAY_TABS, otherEssayTab, splitEssaysByStatus } from './support.ts'

const at = new Date('2026-07-21T00:00:00.000Z')

function essay(id: string, status: EssayStatus): EssaySummary {
  return {
    kind: 'essay',
    id,
    title: id,
    status,
    date: '2026-07-21',
    preview: null,
    createdAt: at,
    updatedAt: at,
  }
}

function daily(id: string): NoteSummary {
  return { kind: 'daily', id, date: '2026-07-21', preview: null, createdAt: at, updatedAt: at }
}

describe('splitEssaysByStatus', () => {
  test('未取得は未取得のまま返す', () => {
    expect(splitEssaysByStatus(null)).toBeNull()
  })

  test('空リストでも両 status のキーが存在する', () => {
    expect(splitEssaysByStatus([])).toEqual({ writing: [], finished: [] })
  })

  test('status ごとに振り分け、各バケット内の順序を保つ', () => {
    const groups = splitEssaysByStatus([
      essay('w1', 'writing'),
      essay('f1', 'finished'),
      essay('w2', 'writing'),
      essay('f2', 'finished'),
    ])
    expect(groups?.writing.map((s) => s.id)).toEqual(['w1', 'w2'])
    expect(groups?.finished.map((s) => s.id)).toEqual(['f1', 'f2'])
  })

  test('essay 以外の summary はどちらのバケットにも入れない', () => {
    expect(splitEssaysByStatus([daily('d1'), essay('w1', 'writing')])).toEqual({
      writing: [essay('w1', 'writing')],
      finished: [],
    })
  })
})

describe('ESSAY_TABS', () => {
  test('サイドバーの描画順は writing → finished', () => {
    expect(ESSAY_TABS).toEqual(['writing', 'finished'])
  })

  test('splitEssaysByStatus の全キーがタブとして到達できる', () => {
    const groups = splitEssaysByStatus([])
    expect(Object.keys(groups ?? {}).toSorted()).toEqual([...ESSAY_TABS].toSorted())
  })
})

describe('otherEssayTab', () => {
  test('同じキーを 2 回押すと元のタブに戻る', () => {
    for (const tab of ESSAY_TABS) {
      expect(otherEssayTab(tab)).not.toBe(tab)
      expect(otherEssayTab(otherEssayTab(tab))).toBe(tab)
    }
  })
})
