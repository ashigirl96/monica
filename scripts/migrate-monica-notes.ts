import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { count, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { readMigrationFiles } from 'drizzle-orm/migrator'

// root の package.json に @tania/note を足すと、root の node_modules を経て他の package からも解決できるので、相対 path で読む。
import { migrations } from '../packages/note/migrations/index.ts'
import { blockById, imageReferences, preview } from '../packages/note/src/body/index.ts'
import { idNumber, noteId } from '../packages/note/src/row.ts'
import { note } from '../packages/note/src/schema.ts'
import { schema as editorSchema } from '../packages/note/src/ui/editor/schema.ts'

type NoteInsert = typeof note.$inferInsert
type NoteRow = typeof note.$inferSelect
type Kind = NoteInsert['kind']

const KINDS: Kind[] = ['daily', 'essay', 'repo_note', 'scratch']

type MonicaNote = {
  id: string
  title: string | null
  kind: string
  project_id: string | null
  content: string
  date: string
  created_at: string
  updated_at: string
  status: string | null
  scratch_of: string | null
}

type Draft = Omit<NoteInsert, 'content' | 'preview'> & { id: number; doc: unknown }

export type Migrated = {
  counts: { kind: Kind; monica: number; tania: number }[]
  merged: { from: string; into: string }[]
}

export function migrateMonicaNotes(options: {
  home: string
  monicaDb: string
  monicaAssets: string
}): Migrated {
  ensureBackendStopped(options.home)
  const sqlite = openTaniaDb(options.home)
  try {
    const db = drizzle(sqlite)
    ensureLatestNoteSchema(sqlite)
    const existing = db.select({ n: count() }).from(note).get()?.n ?? 0
    if (existing > 0) {
      throw new Error(
        `tania.db already has ${existing} Note(s); this script fills only an empty note table`,
      )
    }
    const monica = readMonica(options.monicaDb)
    const { kept, merged } = mergeDailies(monica.notes.map(toDraft))
    const rows: NoteInsert[] = kept.map(({ doc, ...row }) => ({
      ...row,
      content: JSON.stringify(doc),
      preview: preview(doc),
    }))
    const images = join(options.home, 'note-images')
    const copied = copyImages(options.monicaAssets, images)
    try {
      db.transaction((tx) => {
        tx.insert(note).values(rows).run()
        tx.run(sql`UPDATE sqlite_sequence SET seq = max(seq, ${monica.seq}) WHERE name = 'note'`)
        const problems = verify(tx.select().from(note).all(), monica.expected, {
          images,
          monicaAssets: options.monicaAssets,
        })
        if (problems.length > 0) {
          throw new Error(`rolled back:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
        }
      })
    } catch (error) {
      removeAll(copied)
      throw error
    }
    const tania = db.select({ kind: note.kind, n: count() }).from(note).groupBy(note.kind).all()
    return {
      counts: KINDS.map((kind) => ({
        kind,
        monica: monica.expected.alive[kind],
        tania: tania.find((row) => row.kind === kind)?.n ?? 0,
      })),
      merged,
    }
  } finally {
    sqlite.close()
  }
}

function ensureBackendStopped(home: string): void {
  let pid: unknown
  try {
    pid = JSON.parse(readFileSync(join(home, 'backend.json'), 'utf8')).pid
  } catch {
    return
  }
  if (typeof pid === 'number' && isAlive(pid)) {
    throw new Error(
      `the Backend (pid ${pid}) is running on ${home}; quit tania desktop first. ` +
        'If tania is not running, a crashed Backend left backend.json and another process took its pid; remove backend.json',
    )
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function openTaniaDb(home: string): Database {
  const path = join(home, 'tania.db')
  if (!existsSync(path)) {
    throw new Error(
      `${path} does not exist; start tania once so the Backend creates the note table`,
    )
  }
  return new Database(path, { readwrite: true })
}

// note の表を作るのは Backend の起動で、この script は migrate しない。
function ensureLatestNoteSchema(sqlite: Database): void {
  const latest = readMigrationFiles({ migrationsFolder: migrations.folder }).at(-1)?.folderMillis
  const hasTable = sqlite
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(migrations.table)
  // drizzle の migrator も created_at（journal の when）の大小だけで適用済みかを決める。
  const applied = hasTable
    ? sqlite
        .query<{ at: number }, []>(`SELECT max(created_at) AS at FROM ${migrations.table}`)
        .get()?.at
    : undefined
  if (applied !== latest) {
    throw new Error(
      `the note migration of tania.db (${applied ?? 'none'}) is not ${migrations.latest} (${latest}) of this checkout; ` +
        'start the Backend of the same version once, and do not run it against a different release',
    )
  }
}

// Note Ledger が配って掃除する画像の名前の形で、monica も同じ形で置いていた。
const IMAGE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/

// 写した時刻を mtime にするため、cp -p のように属性を写さず、中身だけを書く。
function copyImages(from: string, to: string): string[] {
  mkdirSync(to, { recursive: true })
  const copied: string[] = []
  try {
    for (const name of readdirSync(from)) {
      if (!IMAGE_NAME.test(name)) continue
      const path = join(to, name)
      const bytes = readFileSync(join(from, name))
      // note の表が空の間はどの本文も置き場所の画像を参照しないので、同じ中身なら中断した実行の残りとして書き直す。
      if (existsSync(path) && !readFileSync(path).equals(bytes)) {
        throw new Error(`${path} already exists with different bytes from ${join(from, name)}`)
      }
      // 書く途中で殺されても、画像の名前の file は中身が揃ったものだけになるよう、隣に書いてから rename する。
      const staging = `${path}.migrating`
      try {
        writeFileSync(staging, bytes)
        renameSync(staging, path)
      } finally {
        rmSync(staging, { force: true })
      }
      copied.push(path)
    }
  } catch (error) {
    removeAll(copied)
    throw error
  }
  return copied
}

function removeAll(paths: string[]): void {
  for (const path of paths) rmSync(path, { force: true })
}

// 写した結果と突き合わせるため、写し方とは別に monica の SQL で数える。
type Expected = { alive: Record<Kind, number>; dailyDateCount: number; scratchIds: string[] }

// readonly では WAL の monica.db を -shm 無しで開けず、書ける接続は閉じるときに -wal を書き戻すので、写しを開く。
function readMonica(path: string): { notes: MonicaNote[]; seq: number; expected: Expected } {
  const dir = mkdtempSync(join(tmpdir(), 'monica-notes-'))
  const sqlite = openCopy(path, dir)
  try {
    const counter = sqlite
      .query<{ seq: number }, []>(`SELECT seq FROM sqlite_sequence WHERE name = 'note_counter'`)
      .get()
    const aliveCounts = sqlite
      .query<{ daily: number; dailyDateCount: number; essay: number; project: number }, []>(
        `SELECT count(*) FILTER (WHERE kind = 'daily') AS daily,
                count(DISTINCT date) FILTER (WHERE kind = 'daily') AS dailyDateCount,
                count(*) FILTER (WHERE kind = 'essay') AS essay,
                count(*) FILTER (WHERE kind = 'project') AS project
           FROM notes WHERE deleted_at IS NULL`,
      )
      .get()
    if (!aliveCounts) throw new Error('an aggregate query of monica.db returned no row')
    const scratchIds = sqlite
      .query<{ id: string }, []>(
        'SELECT primary_note_id AS id FROM projects WHERE primary_note_id IS NOT NULL',
      )
      .all()
      .map((row) => row.id)
    const expected = {
      alive: {
        daily: aliveCounts.daily,
        essay: aliveCounts.essay,
        repo_note: aliveCounts.project - scratchIds.length,
        scratch: scratchIds.length,
      },
      dailyDateCount: aliveCounts.dailyDateCount,
      scratchIds,
    }
    // 同じ日付の daily のうち、monica の get-or-create が返したのは rowid の最も小さいもの。
    const notes = sqlite
      .query<MonicaNote, []>(
        `SELECT n.id, n.title, n.kind, n.project_id, n.content, n.date, n.created_at, n.updated_at,
                n.status, p.id AS scratch_of
           FROM notes n LEFT JOIN projects p ON p.primary_note_id = n.id AND p.id = n.project_id
          WHERE n.deleted_at IS NULL
          ORDER BY n.rowid`,
      )
      .all()
    return { notes, seq: counter?.seq ?? 0, expected }
  } finally {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function openCopy(path: string, dir: string): Database {
  const copy = join(dir, 'monica.db')
  copyFileSync(path, copy)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${path}${suffix}`)) copyFileSync(`${path}${suffix}`, `${copy}${suffix}`)
  }
  return new Database(copy, { readwrite: true })
}

function toDraft(monica: MonicaNote): Draft {
  const doc: unknown = JSON.parse(monica.content)
  rewriteLinks(doc)
  const common = {
    id: idNumber(monica.id),
    date: monica.date,
    doc,
    createdAt: new Date(monica.created_at),
    updatedAt: new Date(monica.updated_at),
  }
  switch (monica.kind) {
    case 'daily':
      return { ...common, kind: 'daily' }
    case 'essay':
      return {
        ...common,
        kind: 'essay',
        title: monica.title ?? '',
        status: monica.status === 'finished' ? 'finished' : 'writing',
      }
    case 'project':
      return monica.scratch_of === null
        ? { ...common, kind: 'repo_note', repo: monica.project_id, title: monica.title ?? '' }
        : { ...common, kind: 'scratch', repo: monica.project_id }
    default:
      throw new Error(`${monica.id} has the unknown kind ${monica.kind}`)
  }
}

const MONICA_HOST = 'monica.localhost'
const MONICA_ORIGIN = `http://${MONICA_HOST}:19280`
const OWN_NOTE_PATHS: [RegExp, string][] = [
  [/^\/projects\/([^/]+\/[^/]+)\/notes\/(note-\d+)$/, '/repos/$1/notes/$2'],
  [/^\/essays\/(note-\d+)$/, '/essays/$1'],
]
// monica desktop を起こせば開けるので、explanations を指す link は monica の URL のまま残す。
const EXPLANATION_PATH = /^\/explanations\/expl-\d+$/

function monicaPath(href: string): string | null {
  return href.startsWith(`${MONICA_ORIGIN}/`) ? href.slice(MONICA_ORIGIN.length) : null
}

// 相対 path なら、dev の口でも release の口でも同じ Note に行く。
function rewriteLinks(node: unknown): void {
  if (!isObject(node)) return
  for (const mark of arrayOf(node.marks)) {
    if (!isObject(mark) || mark.type !== 'link' || !isObject(mark.attrs)) continue
    const { href } = mark.attrs
    const path = typeof href === 'string' ? monicaPath(href) : null
    const own = path === null ? undefined : OWN_NOTE_PATHS.find(([pattern]) => pattern.test(path))
    if (path !== null && own) mark.attrs.href = path.replace(...own)
  }
  for (const child of arrayOf(node.content)) rewriteLinks(child)
}

function mergeDailies(drafts: Draft[]): { kept: Draft[]; merged: Migrated['merged'] } {
  const dailyOf = new Map<string, Draft>()
  const kept: Draft[] = []
  const merged: Migrated['merged'] = []
  for (const draft of drafts) {
    const into = draft.kind === 'daily' ? dailyOf.get(draft.date) : undefined
    if (!into) {
      if (draft.kind === 'daily') dailyOf.set(draft.date, draft)
      kept.push(draft)
      continue
    }
    const blocks = topBlocks(into.doc)
    const appended = topBlocks(draft.doc)
    if (!blocks || !appended) {
      throw new Error(
        `cannot append ${noteId(draft.id)} to ${noteId(into.id)}; a body is not a doc of one blockGroup`,
      )
    }
    blocks.push(...appended)
    if (draft.updatedAt > into.updatedAt) into.updatedAt = draft.updatedAt
    merged.push({ from: noteId(draft.id), into: noteId(into.id) })
  }
  return { kept, merged }
}

// エディタの schema では、doc は blockGroup を 1 つだけ持ち、block はその中に並ぶ。
function topBlocks(doc: unknown): unknown[] | null {
  if (!isObject(doc) || doc.type !== 'doc') return null
  const [group, ...rest] = arrayOf(doc.content)
  if (rest.length > 0 || !isObject(group) || group.type !== 'blockGroup') return null
  return Array.isArray(group.content) ? group.content : null
}

function verify(
  migrated: NoteRow[],
  expected: Expected,
  dirs: { images: string; monicaAssets: string },
): string[] {
  const problems: string[] = []
  for (const kind of KINDS) {
    const n = migrated.filter((row) => row.kind === kind).length
    // 同じ日付の Daily は 1 つにまとめるので、Daily は日付の数だけになる。
    const want = kind === 'daily' ? expected.dailyDateCount : expected.alive[kind]
    if (n !== want) problems.push(`${kind} is ${n} in tania, while monica has ${want}`)
  }
  const scratch = migrated.filter((row) => row.kind === 'scratch').map((row) => noteId(row.id))
  if (scratch.toSorted().join() !== expected.scratchIds.toSorted().join()) {
    problems.push(
      `Scratch are ${scratch.join(', ') || 'none'}, while projects.primary_note_id of monica is ${expected.scratchIds.join(', ') || 'none'}`,
    )
  }
  const docs = new Map(
    migrated.map((row): [string, unknown] => [noteId(row.id), JSON.parse(row.content)]),
  )
  for (const [id, doc] of docs) {
    try {
      editorSchema.nodeFromJSON(doc).check()
    } catch (error) {
      problems.push(`${id} does not open in the editor: ${(error as Error).message}`)
    }
    const blockIds = blockIdsOf(doc)
    for (const blockId of new Set(blockIds.filter((b, i) => blockIds.indexOf(b) !== i))) {
      problems.push(`${id} has the block ${blockId} more than once`)
    }
    for (const reference of referencesOf(doc)) {
      const target = docs.get(reference.noteId)
      if (target === undefined) {
        problems.push(`${id} refers to ${reference.noteId}, which is not migrated`)
        continue
      }
      for (const blockId of reference.blockIds) {
        if (blockById(target, blockId) === null) {
          problems.push(`${id} syncs the block ${blockId}, which ${reference.noteId} does not have`)
        }
      }
    }
    for (const href of hrefsOf(doc)) {
      if (href.includes(MONICA_HOST) && !EXPLANATION_PATH.test(monicaPath(href) ?? '')) {
        problems.push(`${id} links to ${href}`)
      }
    }
    for (const name of imageReferences(doc)) {
      const size = sizeOf(join(dirs.monicaAssets, name))
      if (size === null || sizeOf(join(dirs.images, name)) !== size) {
        problems.push(`${id} shows ${name}, which is not copied from ${dirs.monicaAssets} as it is`)
      }
    }
  }
  return problems
}

function sizeOf(path: string): number | null {
  return statSync(path, { throwIfNoEntry: false })?.size ?? null
}

function blockIdsOf(node: unknown): string[] {
  if (!isObject(node)) return []
  const id = node.type === 'blockContainer' && isObject(node.attrs) ? node.attrs.id : undefined
  return [...(typeof id === 'string' ? [id] : []), ...arrayOf(node.content).flatMap(blockIdsOf)]
}

function referencesOf(node: unknown): { noteId: string; blockIds: string[] }[] {
  if (!isObject(node)) return []
  const own = []
  if (node.type === 'noteMention' || node.type === 'syncedBlock') {
    const attrs = isObject(node.attrs) ? node.attrs : {}
    own.push({ noteId: String(attrs.noteId), blockIds: arrayOf(attrs.blockIds).map(String) })
  }
  return [...own, ...arrayOf(node.content).flatMap(referencesOf)]
}

// 書き換えない linkMention や bookmark の href も monica を指していれば止めるので、node の型を問わず見る。
function hrefsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(hrefsOf)
  if (!isObject(value)) return []
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'href' && typeof child === 'string' ? [child] : hrefsOf(child),
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

// 上の module の定数が初期化されてから走るよう、file の末尾に置く。
if (import.meta.main) {
  const [monicaDb, monicaAssets] = process.argv.slice(2)
  if (!monicaDb || !monicaAssets) {
    console.error(
      'usage: bun scripts/migrate-monica-notes.ts <monica.db のコピー> <monica の assets>',
    )
    process.exit(1)
  }
  const home = process.env.TANIA_HOME || join(homedir(), '.tania')
  try {
    const { counts, merged } = migrateMonicaNotes({ home, monicaDb, monicaAssets })
    console.log(`migrated the notes of monica into ${home}\n`)
    console.log(['kind', 'monica', 'tania'].map((cell) => cell.padStart(9)).join(''))
    for (const { kind, monica, tania } of counts) {
      console.log([kind, monica, tania].map((cell) => String(cell).padStart(9)).join(''))
    }
    for (const { from, into } of merged) console.log(`\nappended the blocks of ${from} to ${into}`)
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}
