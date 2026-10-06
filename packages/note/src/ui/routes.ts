import { logicalDate, type Note } from '../contract.ts'

export const DAILY_PATH = '/daily'
export const ESSAYS_PATH = '/essays'
export const REPOS_PATH = '/repos'

export function dailyPath(date: string): string {
  return `${DAILY_PATH}/${date}`
}

// 保存済みの本文の link がこの形を持つ。
export function notePath(id: string): string {
  return `/notes/${id}`
}

export function noteIdOfPath(pathname: string): string | null {
  const match = /^\/notes\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

export type Route =
  | { page: 'today' }
  | { page: 'daily'; date: string }
  | { page: 'note'; id: string }
  | { page: 'not-found' }

export function routeOf(pathname: string): Route {
  if (/^\/(notes\/?|daily\/?)?$/.test(pathname)) return { page: 'today' }
  const daily = /^\/daily\/([^/]+)\/?$/.exec(pathname)
  if (daily) return { page: 'daily', date: daily[1]! }
  const id = noteIdOfPath(pathname)
  if (id !== null) return { page: 'note', id }
  return { page: 'not-found' }
}

// 開いたまま日付の境目を越えても、次に開いた時の今日を指すよう、開くたびに now から導く。
export function todayPath(now: Date): string {
  return dailyPath(logicalDate(now))
}

export function notePagePath(note: Note): string | null {
  switch (note.kind) {
    case 'daily':
      return dailyPath(note.date)
    case 'essay':
    case 'repo_note':
    case 'scratch':
      return null
  }
}
