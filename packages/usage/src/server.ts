import { implement } from '@orpc/server'

import { contract } from './contract.ts'
import { type Db, internals, type UsageLedger } from './usage.ts'

export { migrations } from '../migrations/index.ts'
export { createUsageLedger, featuresOf, type UsageLedger } from './usage.ts'

const os = implement(contract).$context<{ db: Db; usageLedger: UsageLedger }>()

export const router = os.router({
  list: os.list.handler(({ context }) => ({ usages: internals(context.usageLedger).list() })),
})
