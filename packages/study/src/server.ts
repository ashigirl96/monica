import { implement } from '@orpc/server'

import { contract } from './contract.ts'
import { type Db, internals, type StudyLedger } from './study.ts'

export { migrations } from '../migrations/index.ts'
export { tutorBox, type AskUser, type TutorBox, type TutorBoxDeps } from './box.ts'
export { createStudyLedger, type StudyLedger } from './study.ts'

const os = implement(contract).$context<{ db: Db; studyLedger: StudyLedger }>()

export const router = os.router({
  start: os.start.handler(({ context }) => internals(context.studyLedger).start()),
  list: os.list.handler(({ context }) => internals(context.studyLedger).list()),
  get: os.get.handler(({ context, input }) => internals(context.studyLedger).get(input.id)),
  send: os.send.handler(({ context, input }) =>
    internals(context.studyLedger).send(input.id, input.text),
  ),
  // NOT_FOUND を呼び出しの reject にするため、Study を確かめてから generator を返す。
  watch: os.watch.handler(async ({ context, input, signal }) =>
    internals(context.studyLedger).watch(input.id, signal),
  ),
})
