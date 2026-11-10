import { implement } from '@orpc/server'

import { contract } from './contract.ts'
import { type Db, internals, type StudyLedger } from './study.ts'

export { migrations } from '../migrations/index.ts'
export { tutorBox, type AskUser, type TutorBox, type TutorBoxDeps } from './box.ts'
export { createStudyLedger, type StudyLedger, systemJobs } from './study.ts'
export { installTutors } from './tutors.ts'

const os = implement(contract).$context<{ db: Db; studyLedger: StudyLedger }>()

export const router = os.router({
  start: os.start.handler(({ context }) => internals(context.studyLedger).start()),
  list: os.list.handler(({ context }) => internals(context.studyLedger).list()),
  get: os.get.handler(({ context, input }) => internals(context.studyLedger).get(input.id)),
  send: os.send.handler(({ context, input }) =>
    internals(context.studyLedger).send(input.id, input.text),
  ),
  conversation: {
    end: os.conversation.end.handler(({ context, input }) =>
      internals(context.studyLedger).endConversation(input.id),
    ),
  },
  remove: os.remove.handler(({ context, input }) =>
    internals(context.studyLedger).remove(input.id),
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
  shell: os.shell.handler(({ context, input }) =>
    internals(context.studyLedger).shell(input.prefix),
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
