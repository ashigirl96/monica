import { expect, test } from 'bun:test'

import {
  traverseContractProcedures,
  type TraverseContractProcedureCallbackOptions,
} from '@orpc/server'

import { contract } from './contract.ts'

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
