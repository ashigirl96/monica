import { implement } from '@orpc/server'

import { contract } from './contract.ts'
import { type Db, internals, type JobLedger } from './job.ts'

export { migrations } from '../migrations/index.ts'
export { createJobLedger, type JobLedger, type SystemJob } from './job.ts'

const os = implement(contract).$context<{ db: Db; jobLedger: JobLedger }>()

export const router = os.router({
  list: os.list.handler(({ context }) => ({ jobs: internals(context.jobLedger).list() })),
  show: os.show.handler(({ context, input }) => internals(context.jobLedger).show(input.name)),
  run: os.run.handler(({ context, input }) => internals(context.jobLedger).run(input.name)),
})
