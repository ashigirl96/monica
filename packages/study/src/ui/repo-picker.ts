import type { FuzzyPickerItem } from '@monica/ui'

import { RepoSchema } from '../contract.ts'

// GitHub の repo 名は大文字と小文字を区別しない。
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function unlinkedCandidates(candidates: readonly string[], linked: readonly string[]) {
  return candidates.filter((repo) => !linked.some((l) => sameRepo(l, repo)))
}

/** 打った文が Repo の一覧に無い owner/repo なら、それを紐付ける項目。 */
export function typedRepoItem(
  query: string,
  candidates: readonly string[],
  linked: readonly string[],
): FuzzyPickerItem | null {
  if (!RepoSchema.safeParse(query).success) return null
  if ([...candidates, ...linked].some((repo) => sameRepo(repo, query))) return null
  return { key: query, label: `${query} を紐付ける（Repo の一覧に無い）` }
}
