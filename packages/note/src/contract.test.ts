import { expect, test } from 'bun:test'

import {
  traverseContractProcedures,
  type TraverseContractProcedureCallbackOptions,
} from '@orpc/server'

import { contract, displayName, logicalDate } from './contract.ts'

test('every procedure has a description and an output', () => {
  const procedures: TraverseContractProcedureCallbackOptions[] = []
  traverseContractProcedures({ router: contract, path: [] }, (procedure) => {
    procedures.push(procedure)
  })

  const missing = procedures.filter(({ contract: { '~orpc': orpc } }) => {
    const { description } = orpc.meta as { description?: string }
    return !description || !orpc.outputSchema
  })

  expect(procedures.length).toBeGreaterThan(0)
  expect(missing.map(({ path }) => path.join('.'))).toEqual([])
})

test('a Daily is named by its date, an Essay and a Repo Note by the title or Untitled, a Scratch by its Repo', () => {
  expect(displayName({ kind: 'daily', date: '2026-10-06' })).toBe('2026-10-06')
  expect(displayName({ kind: 'essay', title: 'On ledgers' })).toBe('On ledgers')
  expect(displayName({ kind: 'essay', title: '' })).toBe('Untitled')
  expect(displayName({ kind: 'repo_note', title: 'Release plan' })).toBe('Release plan')
  expect(displayName({ kind: 'repo_note', title: '' })).toBe('Untitled')
  expect(displayName({ kind: 'scratch', repo: 'Ashigirl96/Tania' })).toBe('Ashigirl96/Tania')
})

test('the Logical Date counts 4:59 as the day before and 5:00 as the day itself', () => {
  expect(logicalDate(new Date(2026, 9, 6, 4, 59, 59, 999))).toBe('2026-10-05')
  expect(logicalDate(new Date(2026, 9, 6, 5, 0))).toBe('2026-10-06')
  expect(logicalDate(new Date(2026, 9, 6, 0, 0))).toBe('2026-10-05')
  expect(logicalDate(new Date(2026, 9, 6, 23, 59))).toBe('2026-10-06')
})

test('the Logical Date before 5:00 crosses back over months, years and leap days', () => {
  expect(logicalDate(new Date(2026, 6, 1, 2, 0))).toBe('2026-06-30')
  expect(logicalDate(new Date(2026, 0, 1, 3, 0))).toBe('2025-12-31')
  expect(logicalDate(new Date(2024, 2, 1, 1, 0))).toBe('2024-02-29')
  expect(logicalDate(new Date(2026, 2, 1, 1, 0))).toBe('2026-02-28')
})
