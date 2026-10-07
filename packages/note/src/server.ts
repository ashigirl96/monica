import { implement } from '@orpc/server'

import { contract } from './contract.ts'
import { IMPORT_TIMEOUT_MS, importImage, uploadImage } from './image.ts'
import { readLinkMetadata } from './link-metadata.ts'
import { type Db, internals, type NoteLedger } from './note.ts'
import {
  createEssay,
  createRepoNote,
  dailyDates,
  listEssays,
  openDaily,
  openScratch,
} from './open.ts'
import { noteBlock, resolveNoteMention, searchNoteMentions } from './reference.ts'
import { removeNote, restoreNote } from './remove.ts'
import { listRepoNotes } from './repo.ts'
import { toNote, undeletedNote } from './row.ts'
import { saveNote, setEssayStatus } from './save.ts'

export { migrations } from '../migrations/index.ts'
export type { Ghq } from './ghq.ts'
export { createNoteLedger, type NoteLedger, systemJobs } from './note.ts'

const os = implement(contract).$context<{ db: Db; noteLedger: NoteLedger }>()

export const router = os.router({
  get: os.get.handler(({ context, input }) => toNote(undeletedNote(context.db, input.id))),
  save: os.save.handler(({ context, input, errors }) => saveNote(context.db, input, errors)),
  remove: os.remove.handler(({ context, input }) => removeNote(context.db, input.id)),
  restore: os.restore.handler(({ context, input }) => restoreNote(context.db, input.id)),
  daily: {
    open: os.daily.open.handler(({ context, input }) => openDaily(context.db, input.date)),
    dates: os.daily.dates.handler(({ context }) => dailyDates(context.db)),
  },
  repo: {
    candidates: os.repo.candidates.handler(({ context }) => context.noteLedger.repoCandidates()),
  },
  scratch: {
    open: os.scratch.open.handler(({ context, input }) => openScratch(context.db, input.repo)),
  },
  essay: {
    create: os.essay.create.handler(({ context }) => createEssay(context.db)),
    list: os.essay.list.handler(({ context }) => listEssays(context.db)),
    setStatus: os.essay.setStatus.handler(({ context, input }) =>
      setEssayStatus(context.db, input.id, input.status),
    ),
  },
  repoNote: {
    create: os.repoNote.create.handler(({ context, input }) =>
      createRepoNote(context.db, input.repo),
    ),
    list: os.repoNote.list.handler(({ context, input }) =>
      listRepoNotes(context.db, input.repo, input.after),
    ),
  },
  image: {
    upload: os.image.upload.handler(({ context, input }) =>
      uploadImage(internals(context.noteLedger).dir, input.file),
    ),
    import: os.image.import.handler(({ context, input }) =>
      importImage(internals(context.noteLedger), input.url, IMPORT_TIMEOUT_MS),
    ),
  },
  noteMention: {
    search: os.noteMention.search.handler(({ context, input }) =>
      searchNoteMentions(context.db, input.q),
    ),
    resolve: os.noteMention.resolve.handler(({ context, input }) =>
      resolveNoteMention(context.db, input.id),
    ),
  },
  block: {
    get: os.block.get.handler(({ context, input }) =>
      noteBlock(context.db, input.id, input.blockId),
    ),
  },
  linkMetadata: os.linkMetadata.handler(({ context, input }) =>
    readLinkMetadata(input.url, internals(context.noteLedger).stopped),
  ),
})
