import { implement } from '@orpc/server'

import { contract } from './contract.ts'
import type { Db, NoteLedger } from './note.ts'
import { createEssay, createRepoNote, openDaily, openScratch } from './open.ts'
import { removeNote, restoreNote } from './remove.ts'
import { toNote, undeletedNote } from './row.ts'
import { saveNote, setEssayStatus } from './save.ts'

export { migrations } from '../migrations/index.ts'
export { createNoteLedger, type NoteLedger } from './note.ts'

const os = implement(contract).$context<{ db: Db; noteLedger: NoteLedger }>()

export const router = os.router({
  get: os.get.handler(({ context, input }) => toNote(undeletedNote(context.db, input.id))),
  save: os.save.handler(({ context, input, errors }) => saveNote(context.db, input, errors)),
  remove: os.remove.handler(({ context, input }) => removeNote(context.db, input.id)),
  restore: os.restore.handler(({ context, input }) => restoreNote(context.db, input.id)),
  daily: {
    open: os.daily.open.handler(({ context, input }) => openDaily(context.db, input.date)),
  },
  scratch: {
    open: os.scratch.open.handler(({ context, input }) => openScratch(context.db, input.repo)),
  },
  essay: {
    create: os.essay.create.handler(({ context }) => createEssay(context.db)),
    setStatus: os.essay.setStatus.handler(({ context, input }) =>
      setEssayStatus(context.db, input.id, input.status),
    ),
  },
  repoNote: {
    create: os.repoNote.create.handler(({ context, input }) =>
      createRepoNote(context.db, input.repo),
    ),
  },
})
