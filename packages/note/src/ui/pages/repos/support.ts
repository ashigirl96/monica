import { RepoSchema } from '../../../contract.ts'

const LAST_REPO_KEY = 'tania-repos-last'

/** 前回開いた Repo（`owner/repo`）。notes の画面には server に置く ui の状態が無いので、
 * サイドバーの幅と同じく localStorage に置く。 */
export function lastRepo(): string | null {
  try {
    const saved = localStorage.getItem(LAST_REPO_KEY)
    return saved !== null && RepoSchema.safeParse(saved).success ? saved : null
  } catch {
    return null
  }
}

export function setLastRepo(repo: string) {
  try {
    localStorage.setItem(LAST_REPO_KEY, repo)
  } catch {
    // private mode などで書けなくても、前回の Repo が開かないだけなので握りつぶす
  }
}
