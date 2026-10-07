import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { asc } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { migrations } from '../packages/note/migrations/index.ts'
import { createEssay } from '../packages/note/src/open.ts'
import { note } from '../packages/note/src/schema.ts'
import { migrateMonicaNotes } from './migrate-monica-notes'

const scratch = mkdtempSync(join(tmpdir(), 'migrate-monica-notes-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

type MonicaNote = {
  id: string
  kind: 'daily' | 'essay' | 'project'
  title?: string | null
  projectId?: string | null
  status?: string | null
  content?: object
  date?: string
  createdAt?: string
  updatedAt?: string
  deletedAt?: string | null
}

// 実物のコピーは WAL の monica.db だけなので、inWal でなければ -wal と -shm を残さずに写す。
function makeMonica(fixture: {
  notes: MonicaNote[]
  projects?: { id: string; primaryNoteId: string | null }[]
  assets?: Record<string, Uint8Array>
  seq?: number
  inWal?: boolean
}) {
  const dir = mkdtempSync(join(scratch, 'monica-'))
  const live = join(dir, 'live')
  mkdirSync(live)
  const sqlite = new Database(join(live, 'monica.db'))
  sqlite.run('PRAGMA journal_mode = WAL')
  sqlite.run('PRAGMA wal_autocheckpoint = 0')
  sqlite.run(`CREATE TABLE notes (
    id TEXT PRIMARY KEY, title TEXT, kind TEXT NOT NULL, project_id TEXT, content TEXT NOT NULL,
    date TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, status TEXT)`)
  sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, primary_note_id TEXT)')
  sqlite.run('CREATE TABLE note_counter (n INTEGER PRIMARY KEY AUTOINCREMENT)')
  const insert = sqlite.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (const n of fixture.notes) {
    insert.run(
      n.id,
      n.title ?? null,
      n.kind,
      n.projectId ?? null,
      JSON.stringify(n.content ?? docOf(block(`${n.id}-b`, n.id))),
      n.date ?? '2026-07-18',
      n.createdAt ?? '2026-07-18T01:00:00.000Z',
      n.updatedAt ?? '2026-07-18T02:00:00.000Z',
      n.deletedAt ?? null,
      n.status ?? null,
    )
  }
  for (const p of fixture.projects ?? []) {
    sqlite.run('INSERT INTO projects VALUES (?, ?)', [p.id, p.primaryNoteId])
  }
  sqlite.run('INSERT INTO note_counter (n) VALUES (?)', [fixture.seq ?? fixture.notes.length])
  insert.finalize()
  const files = fixture.inWal ? ['monica.db', 'monica.db-wal', 'monica.db-shm'] : ['monica.db']
  // 最後の接続を閉じると、SQLite は -wal を monica.db に書き戻して -wal と -shm を消す。
  if (!fixture.inWal) sqlite.close()
  for (const file of files) copyFileSync(join(live, file), join(dir, file))
  sqlite.close()
  const assets = join(dir, 'assets')
  mkdirSync(assets)
  for (const [name, bytes] of Object.entries(fixture.assets ?? {})) {
    writeFileSync(join(assets, name), bytes)
  }
  return { monicaDb: join(dir, 'monica.db'), monicaAssets: assets }
}

function makeHome(): string {
  const home = mkdtempSync(join(scratch, 'home-'))
  const sqlite = new Database(join(home, 'tania.db'))
  sqlite.run('PRAGMA journal_mode = WAL')
  migrate(drizzle(sqlite), {
    migrationsFolder: migrations.folder,
    migrationsTable: migrations.table,
  })
  sqlite.close()
  return home
}

function notesOf(home: string) {
  const sqlite = new Database(join(home, 'tania.db'))
  try {
    return drizzle(sqlite).select().from(note).orderBy(asc(note.id)).all()
  } finally {
    sqlite.close()
  }
}

function block(id: string, text: string) {
  return {
    attrs: { id },
    content: [{ content: [{ text, type: 'text' }], type: 'paragraph' }],
    type: 'blockContainer',
  }
}

function linked(id: string, href: string) {
  return {
    attrs: { id },
    content: [
      {
        content: [{ marks: [{ attrs: { href }, type: 'link' }], text: 'link', type: 'text' }],
        type: 'paragraph',
      },
    ],
    type: 'blockContainer',
  }
}

function imaged(id: string, name: string) {
  return {
    attrs: { id },
    content: [
      { attrs: { src: `/api/assets/${name}`, uploadId: null, width: null }, type: 'image' },
    ],
    type: 'blockContainer',
  }
}

function mentioning(id: string, noteId: string) {
  return {
    attrs: { id },
    content: [{ content: [{ attrs: { noteId }, type: 'noteMention' }], type: 'paragraph' }],
    type: 'blockContainer',
  }
}

function syncing(id: string, noteId: string, blockIds: string[]) {
  return {
    attrs: { id },
    content: [{ attrs: { blockIds, noteId }, type: 'syncedBlock' }],
    type: 'blockContainer',
  }
}

const IMAGE = '0b1e6c7a-3f2d-4e5a-9b8c-1d2e3f4a5b6c.png'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function docOf(...blocks: object[]) {
  return { content: [{ content: blocks, type: 'blockGroup' }], type: 'doc' }
}

test('生存する Note を種類ごとに写し、kind が project の Note は primary_note_id が指せば Scratch、ほかは Repo Note にする', () => {
  const home = makeHome()
  const monica = makeMonica({
    notes: [
      {
        id: 'note-1',
        kind: 'daily',
        date: '2026-07-17',
        content: docOf(block('b-1', '朝の作業')),
        createdAt: '2026-07-17T01:02:03.456Z',
        updatedAt: '2026-07-17T09:08:07.654Z',
      },
      { id: 'note-2', kind: 'essay', title: '書きかけ', status: null },
      { id: 'note-3', kind: 'essay', title: '書いた', status: 'finished' },
      { id: 'note-4', kind: 'project', projectId: 'ashigirl96/me', title: '' },
      { id: 'note-5', kind: 'project', projectId: 'ashigirl96/me', title: '話題' },
      { id: 'note-6', kind: 'essay', title: '消した', deletedAt: '2026-07-19T00:00:00.000Z' },
    ],
    projects: [
      { id: 'ashigirl96/me', primaryNoteId: 'note-4' },
      { id: 'work-org/repo-b', primaryNoteId: null },
    ],
  })

  const result = migrateMonicaNotes({ home, ...monica })

  const migrated = notesOf(home)
  expect(
    migrated.map(({ id, kind, repo, title, status }) => ({ id, kind, repo, title, status })),
  ).toEqual([
    { id: 1, kind: 'daily', repo: null, title: null, status: null },
    { id: 2, kind: 'essay', repo: null, title: '書きかけ', status: 'writing' },
    { id: 3, kind: 'essay', repo: null, title: '書いた', status: 'finished' },
    { id: 4, kind: 'scratch', repo: 'ashigirl96/me', title: null, status: null },
    { id: 5, kind: 'repo_note', repo: 'ashigirl96/me', title: '話題', status: null },
  ])
  // toMatchObject は Date の値を比べないので、行ごと toEqual で比べる。
  expect(migrated[0]).toEqual({
    id: 1,
    kind: 'daily',
    repo: null,
    title: null,
    status: null,
    date: '2026-07-17',
    content: JSON.stringify(docOf(block('b-1', '朝の作業'))),
    preview: '朝の作業',
    createdAt: new Date('2026-07-17T01:02:03.456Z'),
    updatedAt: new Date('2026-07-17T09:08:07.654Z'),
    deletedAt: null,
  })
  expect(result.counts).toEqual([
    { kind: 'daily', monica: 1, tania: 1 },
    { kind: 'essay', monica: 2, tania: 2 },
    { kind: 'repo_note', monica: 1, tania: 1 },
    { kind: 'scratch', monica: 1, tania: 1 },
  ])
})

test('-wal ごと写した monica.db は -wal にだけある行も読み、渡されたコピーには何も書かない', () => {
  const home = makeHome()
  const monica = makeMonica({
    notes: [{ id: 'note-1', kind: 'essay', title: '-wal にだけある' }],
    inWal: true,
  })
  const filesOfCopy = () =>
    readdirSync(dirname(monica.monicaDb))
      .filter((name) => name.startsWith('monica.db'))
      .toSorted()
      .map((name) => [name, readFileSync(join(dirname(monica.monicaDb), name))])
  const before = filesOfCopy()

  migrateMonicaNotes({ home, ...monica })

  expect(notesOf(home).map((row) => row.title)).toEqual(['-wal にだけある'])
  expect(before.map(([name]) => name)).toEqual(['monica.db', 'monica.db-shm', 'monica.db-wal'])
  expect(filesOfCopy()).toEqual(before)
})

// monica の daily の get-or-create は最古を返したので、遅く作った方は画面から開けなかった。
test('同じ日付の Daily は、古い方の末尾に新しい方の block を足して 1 つにする', () => {
  const home = makeHome()
  const monica = makeMonica({
    notes: [
      {
        id: 'note-12',
        kind: 'daily',
        date: '2026-07-20',
        content: docOf(block('b-12a', '朝'), block('b-12b', '昼')),
        createdAt: '2026-07-19T20:18:06.957Z',
        updatedAt: '2026-07-19T21:00:00.000Z',
      },
      {
        id: 'note-13',
        kind: 'daily',
        date: '2026-07-20',
        content: docOf(block('b-13a', '夜')),
        createdAt: '2026-07-20T11:23:54.405Z',
        updatedAt: '2026-07-20T12:44:04.269Z',
      },
      { id: 'note-14', kind: 'daily', date: '2026-07-21' },
    ],
  })

  const result = migrateMonicaNotes({ home, ...monica })

  const migrated = notesOf(home)
  expect(migrated.map((row) => row.id)).toEqual([12, 14])
  expect(migrated[0]).toEqual({
    id: 12,
    kind: 'daily',
    repo: null,
    title: null,
    status: null,
    date: '2026-07-20',
    content: JSON.stringify(
      docOf(block('b-12a', '朝'), block('b-12b', '昼'), block('b-13a', '夜')),
    ),
    preview: '朝',
    createdAt: new Date('2026-07-19T20:18:06.957Z'),
    updatedAt: new Date('2026-07-20T12:44:04.269Z'),
    deletedAt: null,
  })
  expect(result.counts[0]).toEqual({ kind: 'daily', monica: 3, tania: 2 })
  expect(result.merged).toEqual([{ from: 'note-13', into: 'note-12' }])
})

// 同じ id の block が 2 つあると、Synced Block がどちらを映すか決まらない。
test('結合した Daily に同じ id の block が 2 つできれば rollback する', () => {
  const home = makeHome()
  const monica = makeMonica({
    notes: [
      { id: 'note-12', kind: 'daily', date: '2026-07-20', content: docOf(block('b-same', '朝')) },
      { id: 'note-13', kind: 'daily', date: '2026-07-20', content: docOf(block('b-same', '夜')) },
    ],
  })

  expect(() => migrateMonicaNotes({ home, ...monica })).toThrow(/note-12 .*b-same/)
  expect(notesOf(home)).toEqual([])
})

test.each([
  [
    'エディタの schema に無い node',
    { attrs: { id: 'b-1' }, content: [{ type: 'mystery' }], type: 'blockContainer' },
    /Unknown node type: mystery/,
  ],
  [
    'エディタの schema が許さない並び',
    { content: [{ type: 'paragraph' }, { type: 'paragraph' }], type: 'blockContainer' },
    /Invalid content for node blockContainer/,
  ],
])('%s を持つ本文があれば、エディタで開けないので rollback する', (_, offending, reason) => {
  const home = makeHome()
  const monica = makeMonica({
    notes: [{ id: 'note-1', kind: 'essay', title: '開けない', content: docOf(offending) }],
  })

  expect(() => migrateMonicaNotes({ home, ...monica })).toThrow(
    /note-1 does not open in the editor/,
  )
  expect(() => migrateMonicaNotes({ home, ...monica })).toThrow(reason)
  expect(notesOf(home)).toEqual([])
})

// 削除済みの Note を移さないので、そろえないと末尾の番号が再利用される。
test('次に作る Note の番号は、monica の採番の続きになる', () => {
  const home = makeHome()
  const monica = makeMonica({
    notes: [
      { id: 'note-1', kind: 'essay', title: '残す' },
      { id: 'note-3', kind: 'essay', title: '消した', deletedAt: '2026-07-19T00:00:00.000Z' },
    ],
    seq: 3,
  })

  migrateMonicaNotes({ home, ...monica })

  const sqlite = new Database(join(home, 'tania.db'))
  const created = createEssay(drizzle(sqlite))
  sqlite.close()
  expect(created.id).toBe('note-4')
})

test('自分の Note を指す monica の URL は tania の相対 path にし、ほかの link は残す', () => {
  const home = makeHome()
  const kept = [
    '/notes/note-3',
    'http://monica.localhost:19280/explanations/expl-35',
    'https://github.com/ashigirl96/tania/pull/171',
  ]
  const monica = makeMonica({
    notes: [
      { id: 'note-3', kind: 'essay', title: '参照先' },
      { id: 'note-73', kind: 'project', projectId: 'ashigirl96/monica', title: '参照先' },
      {
        id: 'note-81',
        kind: 'daily',
        content: docOf(
          linked('b-1', 'http://monica.localhost:19280/projects/ashigirl96/monica/notes/note-73'),
          linked('b-2', 'http://monica.localhost:19280/essays/note-3'),
          ...kept.map((href, i) => linked(`b-kept-${i}`, href)),
        ),
      },
    ],
  })

  migrateMonicaNotes({ home, ...monica })

  expect(notesOf(home).find((row) => row.id === 81)?.content).toBe(
    JSON.stringify(
      docOf(
        linked('b-1', '/repos/ashigirl96/monica/notes/note-73'),
        linked('b-2', '/essays/note-3'),
        ...kept.map((href, i) => linked(`b-kept-${i}`, href)),
      ),
    ),
  )
})

test.each([
  [
    '書き換えの形に当てはまらない link',
    linked('b-1', 'http://monica.localhost:19280/projects/a/b'),
  ],
  [
    'link mark でない node の href',
    {
      attrs: { id: 'b-1' },
      content: [
        {
          content: [
            {
              attrs: { href: 'http://monica.localhost:19280/essays/note-3', title: 't' },
              type: 'linkMention',
            },
          ],
          type: 'paragraph',
        },
      ],
      type: 'blockContainer',
    },
  ],
])('%s が monica の URL を指していたら、何も書かずに止まる', (_, offending) => {
  const home = makeHome()
  const monica = makeMonica({
    notes: [
      { id: 'note-3', kind: 'essay', title: '参照先' },
      { id: 'note-4', kind: 'daily', content: docOf(offending) },
    ],
  })

  expect(() => migrateMonicaNotes({ home, ...monica })).toThrow(/note-4 .*monica\.localhost/)
  expect(notesOf(home)).toEqual([])
})

// 元の mtime を残すと、Backend の起動直後の画像の掃除が 48 時間の猶予なしに消す。
test('monica の画像を同じ名前で note-images に写し、mtime は写した時刻にする', () => {
  const home = makeHome()
  const monica = makeMonica({
    notes: [{ id: 'note-1', kind: 'essay', title: '画像', content: docOf(imaged('b-1', IMAGE)) }],
    assets: { [IMAGE]: PNG },
  })
  utimesSync(join(monica.monicaAssets, IMAGE), new Date('2026-07-18'), new Date('2026-07-18'))
  const startedAt = Date.now()

  migrateMonicaNotes({ home, ...monica })

  const copied = join(home, 'note-images', IMAGE)
  expect(new Uint8Array(readFileSync(copied))).toEqual(PNG)
  expect(statSync(copied).mtimeMs).toBeGreaterThanOrEqual(Math.floor(startedAt / 1000) * 1000)
})

test('image の src のファイルが monica の assets に無ければ rollback し、写した画像も消す', () => {
  const home = makeHome()
  const missing = '7c9e6679-7425-40de-944b-e07fc1f90ae7.png'
  const placedBefore = 'a3bb189e-8bf9-3888-9912-ace4e6543002.png'
  mkdirSync(join(home, 'note-images'))
  writeFileSync(join(home, 'note-images', placedBefore), PNG)
  const monica = makeMonica({
    notes: [
      {
        id: 'note-1',
        kind: 'essay',
        title: '画像',
        content: docOf(imaged('b-1', IMAGE), imaged('b-2', missing)),
      },
    ],
    assets: { [IMAGE]: PNG },
  })

  expect(() => migrateMonicaNotes({ home, ...monica })).toThrow(new RegExp(`note-1 .*${missing}`))
  expect(notesOf(home)).toEqual([])
  expect(readdirSync(join(home, 'note-images'))).toEqual([placedBefore])
})

// Note Ledger は小文字の UUID の名前の画像しか配らないので、写さない。
test('画像の名前の形でないため写さなかったファイルを本文が参照していれば rollback する', () => {
  const home = makeHome()
  const upper = IMAGE.toUpperCase().replace('.PNG', '.png')
  const monica = makeMonica({
    notes: [{ id: 'note-1', kind: 'essay', title: '画像', content: docOf(imaged('b-1', upper)) }],
    assets: { [upper]: PNG },
  })

  expect(() => migrateMonicaNotes({ home, ...monica })).toThrow(new RegExp(`note-1 .*${upper}`))
  expect(notesOf(home)).toEqual([])
  expect(readdirSync(join(home, 'note-images'))).toEqual([])
})

const referred: MonicaNote[] = [
  { id: 'note-28', kind: 'project', projectId: 'ashigirl96/me', title: '参照元の置き場' },
  {
    id: 'note-30',
    kind: 'daily',
    content: docOf(block('b-30a', 'a'), block('b-30b', 'b')),
  },
  { id: 'note-31', kind: 'essay', title: '消した', deletedAt: '2026-07-19T00:00:00.000Z' },
]

test('Note Mention と Synced Block の参照先がすべて移っていれば commit する', () => {
  const home = makeHome()
  const monica = makeMonica({
    notes: [
      ...referred,
      {
        id: 'note-40',
        kind: 'essay',
        title: '参照元',
        content: docOf(mentioning('b-1', 'note-30'), syncing('b-2', 'note-30', ['b-30a', 'b-30b'])),
      },
    ],
  })

  migrateMonicaNotes({ home, ...monica })

  expect(notesOf(home).map((row) => row.id)).toEqual([28, 30, 40])
})

test.each([
  ['削除済みの Note を指す Note Mention', mentioning('b-1', 'note-31'), /note-40 .*note-31/],
  [
    '無い block を指す Synced Block',
    syncing('b-1', 'note-30', ['b-30a', 'b-gone']),
    /note-40 .*b-gone/,
  ],
])('%s があれば rollback する', (_, offending, reason) => {
  const home = makeHome()
  const monica = makeMonica({
    notes: [
      ...referred,
      { id: 'note-40', kind: 'essay', title: '参照元', content: docOf(offending) },
    ],
  })

  expect(() => migrateMonicaNotes({ home, ...monica })).toThrow(reason)
  expect(notesOf(home)).toEqual([])
})

// monica は primary_note_id が指す削除済みの Note を、project を開いたときに復元していた。
test('primary_note_id が削除済みの Note を指していれば、Scratch が足りないので rollback する', () => {
  const home = makeHome()
  const monica = makeMonica({
    notes: [
      {
        id: 'note-2',
        kind: 'project',
        projectId: 'ashigirl96/me',
        title: '',
        deletedAt: '2026-07-19T00:00:00.000Z',
      },
      { id: 'note-3', kind: 'project', projectId: 'ashigirl96/me', title: '話題' },
    ],
    projects: [{ id: 'ashigirl96/me', primaryNoteId: 'note-2' }],
  })

  expect(() => migrateMonicaNotes({ home, ...monica })).toThrow(/Scratch .*note-2/)
  expect(notesOf(home)).toEqual([])
})

test('note の表に行があれば、何も書かずに止まる。2 回目の実行はここで止まる', () => {
  const home = makeHome()
  const first = makeMonica({ notes: [{ id: 'note-1', kind: 'essay', title: '1 回目' }] })
  migrateMonicaNotes({ home, ...first })
  const second = makeMonica({ notes: [{ id: 'note-2', kind: 'essay', title: '2 回目' }] })

  expect(() => migrateMonicaNotes({ home, ...second })).toThrow(/already has 1 Note/)
  expect(notesOf(home).map((row) => row.title)).toEqual(['1 回目'])
})

function writeEndpoint(home: string, pid: number) {
  writeFileSync(
    join(home, 'backend.json'),
    JSON.stringify({ port: 1, token: 't', pid, startedAt: new Date().toISOString() }),
  )
}

test('backend.json の pid が生きていれば、何も書かずに止まる', () => {
  const home = makeHome()
  writeEndpoint(home, process.pid)
  const monica = makeMonica({ notes: [{ id: 'note-1', kind: 'essay', title: '書く' }] })

  expect(() => migrateMonicaNotes({ home, ...monica })).toThrow(/Backend .*running/)
  expect(notesOf(home)).toEqual([])
})

// Backend が落ちると backend.json が残る。
test('backend.json の pid が死んでいれば、そのまま写す', async () => {
  const home = makeHome()
  const exited = Bun.spawn(['true'])
  await exited.exited
  writeEndpoint(home, exited.pid)
  const monica = makeMonica({ notes: [{ id: 'note-1', kind: 'essay', title: '書く' }] })

  migrateMonicaNotes({ home, ...monica })

  expect(notesOf(home).map((row) => row.id)).toEqual([1])
})

test.each([
  ['新しい release が足した migration', '+'],
  ['checkout が足した migration を持たない古い release', '-'],
])(
  'tania.db の note の migration が checkout の最新とずれていれば（%s）、何も書かずに止まる',
  (_, sign) => {
    const home = makeHome()
    const sqlite = new Database(join(home, 'tania.db'))
    sqlite.run(`UPDATE ${migrations.table} SET created_at = created_at ${sign} 1`)
    sqlite.close()
    const monica = makeMonica({ notes: [{ id: 'note-1', kind: 'essay', title: '書く' }] })

    expect(() => migrateMonicaNotes({ home, ...monica })).toThrow(/migration/)
    expect(notesOf(home)).toEqual([])
  },
)

test('Backend が note の表を作る前の tania.db では、何も書かずに止まる', () => {
  const home = mkdtempSync(join(scratch, 'home-'))
  new Database(join(home, 'tania.db')).close()
  const monica = makeMonica({ notes: [{ id: 'note-1', kind: 'essay', title: '書く' }] })

  expect(() => migrateMonicaNotes({ home, ...monica })).toThrow(/migration/)
})
