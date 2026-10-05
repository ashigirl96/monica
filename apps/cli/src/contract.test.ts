import { expect, test } from 'bun:test'

import {
  traverseContractProcedures,
  type TraverseContractProcedureCallbackOptions,
} from '@orpc/server'

import { contract, formatters } from './contract.ts'

const procedures: TraverseContractProcedureCallbackOptions[] = []
traverseContractProcedures({ router: contract, path: [] }, (procedure) => {
  procedures.push(procedure)
})

const meta = (procedure: TraverseContractProcedureCallbackOptions) =>
  procedure.contract['~orpc'].meta as { description?: string; cli?: boolean }
const dotted = (procedure: TraverseContractProcedureCallbackOptions) => procedure.path.join('.')

test('every procedure has a description for the help and an output for --format json', () => {
  const missing = procedures.filter(
    (procedure) => !meta(procedure).description || !procedure.contract['~orpc'].outputSchema,
  )

  expect(procedures.length).toBeGreaterThan(0)
  expect(missing.map(dotted)).toEqual([])
})

test('every procedure the CLI exposes has a text formatter at the same path', () => {
  const exposed = procedures.filter((procedure) => meta(procedure).cli === true)
  const missing = exposed.filter((procedure) => {
    const formatter = procedure.path.reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | undefined)?.[key],
      formatters,
    )
    return typeof formatter !== 'function'
  })

  expect(exposed.length).toBeGreaterThan(0)
  expect(missing.map(dotted)).toEqual([])
})
