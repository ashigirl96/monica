import { logicalDate, type Note, sameRepo } from '../contract.ts'

export const DAILY_PATH = '/daily'
export const ESSAYS_PATH = '/essays'
export const REPOS_PATH = '/repos'

export function dailyPath(date: string): string {
  return `${DAILY_PATH}/${date}`
}

export function essayPath(id: string): string {
  return `${ESSAYS_PATH}/${id}`
}

export function repoPath(repo: string): string {
  return `${REPOS_PATH}/${repo}`
}

export function repoNotePath(repo: string, id: string): string {
  return `${repoPath(repo)}/notes/${id}`
}

// 保存済みの本文の link がこの形を持つ。
export function notePath(id: string): string {
  return `/notes/${id}`
}

export function noteIdOfPath(pathname: string): string | null {
  return idOfPath(/^\/notes\/([^/]+)\/?$/, pathname)
}

function idOfPath(pattern: RegExp, pathname: string): string | null {
  const match = pattern.exec(pathname)
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
  | { page: 'essays' }
  | { page: 'essay'; id: string }
  | { page: 'repos' }
  | { page: 'repo'; repo: string; noteId: string | null }
  | { page: 'note'; id: string }
  | { page: 'not-found' }

export function routeOf(pathname: string): Route {
  if (/^\/(notes\/?|daily\/?)?$/.test(pathname)) return { page: 'today' }
  const daily = /^\/daily\/([^/]+)\/?$/.exec(pathname)
  if (daily) return { page: 'daily', date: daily[1]! }
  if (/^\/essays\/?$/.test(pathname)) return { page: 'essays' }
  const essayId = idOfPath(/^\/essays\/([^/]+)\/?$/, pathname)
  if (essayId !== null) return { page: 'essay', id: essayId }
  if (/^\/repos\/?$/.test(pathname)) return { page: 'repos' }
  const repo = /^\/repos\/([^/]+\/[^/]+)(?:\/notes\/([^/]+))?\/?$/.exec(pathname)
  if (repo) return { page: 'repo', repo: repo[1]!, noteId: repo[2] ?? null }
  const id = noteIdOfPath(pathname)
  if (id !== null) return { page: 'note', id }
  return { page: 'not-found' }
}

/** 消せる種類（Essay と Repo Note）の画面が開いている Note の id。 */
export function openNoteIdOfPath(pathname: string): string | null {
  const route = routeOf(pathname)
  if (route.page === 'essay') return route.id
  if (route.page === 'repo') return route.noteId
  return null
}

// 開いたまま日付の境目を越えても、次に開いた時の今日を指すよう、開くたびに now から導く。
export function todayPath(now: Date): string {
  return dailyPath(logicalDate(now))
}

export function notePagePath(note: Note): string {
  switch (note.kind) {
    case 'daily':
      return dailyPath(note.date)
    case 'essay':
      return essayPath(note.id)
    case 'repo_note':
      return repoNotePath(note.repo, note.id)
    case 'scratch':
      return repoPath(note.repo)
  }
}

/** `/repos/:owner/:repo/notes/:id` の id が、その Repo の Repo Note でなかったときの行き先。 */
export function repoNoteRedirect(repo: string, note: Note): string | null {
  const inRepo = 'repo' in note && sameRepo(note.repo, repo)
  if (inRepo && note.kind === 'repo_note') return null
  if (inRepo && note.kind === 'scratch') return repoPath(repo)
  return notePagePath(note)
}
