import { oc } from '@orpc/contract'
import { createSchemaFactory } from 'drizzle-zod'
import { z } from 'zod'

import { note } from './schema.ts'

// notes の口にだけ載せ、CLI には出さないので、meta に cli を持たない。
const meta = oc.$meta<{ description?: string }>({})
const { createSelectSchema } = createSchemaFactory({ coerce: { date: true } })

const NoteRowSchema = createSelectSchema(note)

// monica の本文が持つ src の形のまま（ADR-0019）。
export const IMAGE_URL_PREFIX = '/api/assets/'

// notes の口は Host がこれ以外の request を断る（DNS rebinding）ので、名前を足すとその口に届く経路も増える。
// 保存される link は tania.localhost で書かれるが、ユーザーが同じ Backend を別の名前で開くこともある。
export const NOTES_HOSTNAMES = ['tania.localhost', 'localhost', '127.0.0.1']

export const NoteIdSchema = z
  .string()
  .regex(/^note-[1-9]\d*$/)
  .describe('note-N')

export const RepoSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)
  .describe('owner/repo')

export const EssayStatusSchema = NoteRowSchema.shape.status.unwrap()

// node ごとの形はエディタの schema が決めるので、一番上の type だけを見る。
export const DocSchema = z.looseObject({ type: z.literal('doc') })

const common = {
  id: NoteIdSchema,
  date: NoteRowSchema.shape.date.describe(
    'the Logical Date the Note was made on, which for a Daily is the day it is for',
  ),
  content: DocSchema,
  createdAt: NoteRowSchema.shape.createdAt,
  updatedAt: NoteRowSchema.shape.updatedAt,
}

export const NoteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), ...common }),
  z.object({ kind: z.literal('essay'), title: z.string(), status: EssayStatusSchema, ...common }),
  z.object({ kind: z.literal('repo_note'), repo: z.string(), title: z.string(), ...common }),
  z.object({ kind: z.literal('scratch'), repo: z.string(), ...common }),
])

// 中の node の形は Note の本文と同じくエディタの schema が決める。
export const BlockSchema = z.looseObject({ type: z.literal('blockContainer') })

export const NoteMentionCandidateSchema = z.object({
  id: NoteIdSchema,
  displayName: z.string(),
  preview: NoteRowSchema.shape.preview,
})

export const saveErrors = {
  CONFLICT: {
    status: 409,
    message: 'the Note was saved after the version the edit is based on',
  },
}

export type EssayStatus = z.infer<typeof EssayStatusSchema>
export type Doc = z.infer<typeof DocSchema>
export type Note = z.infer<typeof NoteSchema>
export type NoteMentionCandidate = z.infer<typeof NoteMentionCandidateSchema>

export type Named =
  | { kind: 'daily'; date: string }
  | { kind: 'essay' | 'repo_note'; title: string }
  | { kind: 'scratch'; repo: string }

export function displayName(named: Named): string {
  switch (named.kind) {
    case 'daily':
      return named.date
    case 'essay':
    case 'repo_note':
      return named.title || 'Untitled'
    case 'scratch':
      return named.repo
  }
}

const DAY_BOUNDARY_HOUR = 5

/** Logical Date の `YYYY-MM-DD`。local time の 5 時より前は前の日に数える。 */
export function logicalDate(at: Date): string {
  const day = at.getHours() < DAY_BOUNDARY_HOUR ? at.getDate() - 1 : at.getDate()
  // 時を引かずに日を引くので、夏時間の切り替えの日も 1 日だけ戻る。
  const date = new Date(at.getFullYear(), at.getMonth(), day)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

const id = NoteIdSchema

// 本文の attrs の id には、貼った URL から緩く抜き出したものもあるので、形を問わず受ける。
const referencedId = z
  .string()
  .describe('a Note id as a body holds it; one no Note has is not found')

export const contract = {
  get: meta
    .meta({ description: 'Read a Note; a deleted Note is not found' })
    .input(z.object({ id }))
    .output(NoteSchema),
  save: meta
    .meta({
      description:
        'Save the body of a Note, and the title of an Essay or a Repo Note, unless it was saved after expectedUpdatedAt',
    })
    .errors(saveErrors)
    .input(
      z.object({
        id,
        content: DocSchema,
        title: z
          .string()
          .optional()
          .describe('the title of an Essay or a Repo Note; left as it is when omitted'),
        expectedUpdatedAt: NoteRowSchema.shape.updatedAt.describe(
          'the updatedAt of the version the edit is based on',
        ),
      }),
    )
    .output(z.object({ updatedAt: NoteRowSchema.shape.updatedAt })),
  remove: meta
    .meta({ description: 'Delete an Essay or a Repo Note; a Daily and a Scratch stay' })
    .input(z.object({ id }))
    .output(z.void()),
  restore: meta
    .meta({ description: 'Undo the deletion of a Note' })
    .input(z.object({ id }))
    .output(NoteSchema),
  daily: {
    open: meta
      .meta({ description: 'Get the Daily of a Logical Date, making it when there is none' })
      .input(z.object({ date: z.iso.date().describe('YYYY-MM-DD') }))
      .output(NoteSchema),
    dates: meta
      .meta({ description: 'List the Logical Dates that have a Daily, newest first' })
      .output(z.array(z.iso.date().describe('YYYY-MM-DD'))),
  },
  scratch: {
    open: meta
      .meta({ description: 'Get the Scratch of a Repo, making it when there is none' })
      .input(z.object({ repo: RepoSchema }))
      .output(NoteSchema),
  },
  essay: {
    create: meta.meta({ description: 'Make an Essay with no title, writing' }).output(NoteSchema),
    setStatus: meta
      .meta({ description: 'Set an Essay to writing or finished' })
      .input(z.object({ id, status: EssayStatusSchema }))
      .output(NoteSchema),
  },
  repoNote: {
    create: meta
      .meta({ description: 'Make a Repo Note with no title' })
      .input(z.object({ repo: RepoSchema }))
      .output(NoteSchema),
  },
  noteMention: {
    search: meta
      .meta({
        description:
          'Find up to 20 Notes whose title, name, preview or Repo has q, ignoring case, the most recently updated first; a deleted Note is not among them',
      })
      .input(z.object({ q: z.string() }))
      .output(z.array(NoteMentionCandidateSchema)),
    resolve: meta
      .meta({
        description:
          'Read the name the Note a Note Mention points at has now; a deleted Note is not found',
      })
      .input(z.object({ id: referencedId }))
      .output(z.object({ displayName: z.string() })),
  },
  block: {
    get: meta
      .meta({
        description: 'Read a block of a Note with the blocks nested in it; a deleted Note has none',
      })
      .input(z.object({ id: referencedId, blockId: z.string() }))
      .output(BlockSchema),
  },
}
