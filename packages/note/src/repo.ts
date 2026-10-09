import { and, asc, desc, eq, isNotNull, isNull, lt, max, or, sql } from 'drizzle-orm'

import { RepoSchema, type RepoNotesCursor, type RepoNotesPage } from './contract.ts'
import type { Db } from './db.ts'
import type { Ghq } from './ghq.ts'
import { idNumber, isRepo, noteId } from './row.ts'
import { note } from './schema.ts'

const REPO_NOTES_PAGE_SIZE = 100
const GHQ_TIMEOUT_MS = 5000
const GITHUB_PREFIX = 'github.com/'

// Note は書いた時点の綴りを持ち続けるので、改名した Repo と checkout を消した Repo の Note には、ghq の checkout からは辿り着けない。
export async function repoCandidates(db: Db, ghq: Ghq): Promise<string[]> {
  const candidates = notedRepos(db)
  const seen = new Set(candidates.map((repo) => repo.toLowerCase()))
  for (const repo of await checkouts(ghq)) {
    if (seen.has(repo.toLowerCase())) continue
    seen.add(repo.toLowerCase())
    candidates.push(repo)
  }
  return candidates
}

function notedRepos(db: Db): string[] {
  const updatedAt = max(note.updatedAt)
  // SQLite は max() と並べた素の列を、max を取った行から取るので、repo は一番最近に更新した Note の綴りになる。
  return db
    .select({ repo: note.repo, updatedAt })
    .from(note)
    .where(and(isNotNull(note.repo), isNull(note.deletedAt)))
    .groupBy(sql`lower(${note.repo})`)
    .orderBy(desc(updatedAt), asc(sql`lower(${note.repo})`))
    .all()
    .map((row) => row.repo!)
}

async function checkouts(ghq: Ghq): Promise<string[]> {
  const controller = new AbortController()
  // AbortSignal.timeout の timer はテストから進められないので、setTimeout で張る。
  const timer = setTimeout(
    () => controller.abort(new Error(`ghq list timed out after ${GHQ_TIMEOUT_MS / 1000}s`)),
    GHQ_TIMEOUT_MS,
  )
  // ghq を kill しても、ghq の子が stdout を握って残ると list は終わらないので、ghq の終わりを待たない。
  const cutOff = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason))
  })
  try {
    const paths = await Promise.race([ghq.list(controller.signal), cutOff])
    return paths
      .filter((path) => path.startsWith(GITHUB_PREFIX))
      .map((path) => path.slice(GITHUB_PREFIX.length))
      .filter((repo) => RepoSchema.safeParse(repo).success)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

// offset で頁を切ると、読み込みの途中で Note が増えたときに同じ行が次の頁にも出る。
export function listRepoNotes(
  db: Db,
  repo: string,
  after: RepoNotesCursor | undefined,
): RepoNotesPage {
  const rows = db
    .select({
      id: note.id,
      date: note.date,
      title: note.title,
      preview: note.preview,
      updatedAt: note.updatedAt,
    })
    .from(note)
    .where(
      and(
        eq(note.kind, 'repo_note'),
        isRepo(repo),
        isNull(note.deletedAt),
        after === undefined ? undefined : olderThan(after),
      ),
    )
    .orderBy(desc(note.date), desc(note.id))
    .limit(REPO_NOTES_PAGE_SIZE + 1)
    .all()
  const notes = rows
    .slice(0, REPO_NOTES_PAGE_SIZE)
    .map((row) => ({ ...row, id: noteId(row.id), title: row.title! }))
  const last = notes.at(-1)
  const next = rows.length > REPO_NOTES_PAGE_SIZE && last ? { date: last.date, id: last.id } : null
  return { notes, next }
}

function olderThan(cursor: RepoNotesCursor) {
  return or(
    lt(note.date, cursor.date),
    and(eq(note.date, cursor.date), lt(note.id, idNumber(cursor.id))),
  )
}
