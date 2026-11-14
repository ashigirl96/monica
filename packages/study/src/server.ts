import { implement, type ORPCErrorConstructorMap } from '@orpc/server'

import { contract, type studyErrors } from './contract.ts'
import { isRefusal, type Refusal } from './lifecycle.ts'
import { type Db, internals, type StudyLedger } from './study.ts'

export { migrations } from '../migrations/index.ts'
export { tutorBox, type AskUser, type TutorBox, type TutorBoxDeps } from './box.ts'
export { createStudyLedger, type StudyLedger, systemJobs } from './study.ts'
export { installTutors } from './tutors.ts'

const os = implement(contract).$context<{ db: Db; studyLedger: StudyLedger }>()

// 断った理由を CONFLICT と TOO_MANY_REQUESTS の data に載せ、画面が理由ごとの文を出せるようにする。
function admitted<T>(result: T | Refusal, errors: ORPCErrorConstructorMap<typeof studyErrors>): T {
  if (!isRefusal(result)) return result
  const { refused: reason, message } = result
  if (reason === 'tutor-capacity') throw errors.TOO_MANY_REQUESTS({ message, data: { reason } })
  throw errors.CONFLICT({ message, data: { reason } })
}

export const router = os.router({
  start: os.start.handler(({ context }) => internals(context.studyLedger).start()),
  list: os.list.handler(({ context }) => internals(context.studyLedger).list()),
  get: os.get.handler(({ context, input }) => internals(context.studyLedger).get(input.id)),
  send: os.send.handler(({ context, input: { id, text, conversationId, ...choice }, errors }) =>
    admitted(internals(context.studyLedger).send(id, text, choice, conversationId), errors),
  ),
  models: os.models.handler(({ context }) => internals(context.studyLedger).models()),
  conversation: {
    end: os.conversation.end.handler(async ({ context, input, errors }) =>
      admitted(
        await internals(context.studyLedger).endConversation(input.id, input.reflect ?? false),
        errors,
      ),
    ),
  },
  remove: os.remove.handler(async ({ context, input, errors }) =>
    admitted(await internals(context.studyLedger).remove(input.id), errors),
  ),
  permission: {
    answer: os.permission.answer.handler(({ context, input }) =>
      internals(context.studyLedger).answerPermission(input.id, input.allow),
    ),
  },
  repo: {
    link: os.repo.link.handler(({ context, input }) =>
      internals(context.studyLedger).linkRepo(input.id, input.repo),
    ),
    unlink: os.repo.unlink.handler(({ context, input }) =>
      internals(context.studyLedger).unlinkRepo(input.id, input.repo),
    ),
    studies: os.repo.studies.handler(({ context, input }) =>
      internals(context.studyLedger).studiesOfRepo(input.repo),
    ),
  },
  // NOT_FOUND を呼び出しの reject にするため、Study を確かめてから generator を返す。
  watch: os.watch.handler(async ({ context, input, signal }) =>
    internals(context.studyLedger).watch(input.id, signal),
  ),
  shell: os.shell.handler(({ context, input, errors }) =>
    admitted(internals(context.studyLedger).shell(input.prefix), errors),
  ),
  artifact: {
    list: os.artifact.list.handler(({ context, input }) =>
      internals(context.studyLedger).listArtifacts(input.id),
    ),
    read: os.artifact.read.handler(({ context, input }) =>
      internals(context.studyLedger).readArtifact(input.id, input.path),
    ),
    open: os.artifact.open.handler(({ context, input }) =>
      internals(context.studyLedger).openArtifact(input.id, input.path),
    ),
  },
})
