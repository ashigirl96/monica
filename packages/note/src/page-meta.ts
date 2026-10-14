import { and, eq, isNull } from 'drizzle-orm'
import { escapeAttribute } from 'entities'

import type { Db } from './db.ts'
import { displayNameOf, idNumber, isRepo, type NoteRow } from './row.ts'
import { note } from './schema.ts'
import { routeOf } from './ui/routes.ts'

const SITE_NAME = 'monica'

// SPA は route ごとに同じ index.html を返すので、貼った URL の OGP を読む側には Note の名前が届かない。
export function withPageMeta(db: Db, pathname: string, page: Response): Response {
  const row = noteOfPath(db, pathname)
  if (!row) return page
  const meta: [string, string | null][] = [
    ['og:title', displayNameOf(row)],
    ['og:description', row.preview],
    ['og:site_name', SITE_NAME],
  ]
  const tags = meta
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `<meta property="${key}" content="${escapeAttribute(value)}" />`)
    .join('')
  return new HTMLRewriter()
    .on('head', {
      element(el) {
        el.prepend(tags, { html: true })
      },
    })
    .transform(page)
}

// 画面を開くと作られる Daily と Scratch も、ここでは作らずに在るものだけを読む。
function noteOfPath(db: Db, pathname: string): NoteRow | undefined {
  const route = routeOf(pathname)
  const undeleted = isNull(note.deletedAt)
  switch (route.page) {
    case 'essay':
    case 'note':
      return byId(db, route.id)
    case 'repo':
      if (route.noteId !== null) return byId(db, route.noteId)
      return db
        .select()
        .from(note)
        .where(and(eq(note.kind, 'scratch'), isRepo(route.repo), undeleted))
        .get()
    case 'daily':
      return db
        .select()
        .from(note)
        .where(and(eq(note.kind, 'daily'), eq(note.date, route.date), undeleted))
        .get()
    default:
      return undefined
  }
}

function byId(db: Db, id: string): NoteRow | undefined {
  const number = idNumber(id)
  if (!Number.isSafeInteger(number)) return undefined
  return db
    .select()
    .from(note)
    .where(and(eq(note.id, number), isNull(note.deletedAt)))
    .get()
}
