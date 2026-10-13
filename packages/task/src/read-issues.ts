import { ORPCError } from '@orpc/server'

import { type GitHubIssue, oneLine } from './github.ts'
import { formatRef, type IssueRef, parseRef } from './ref.ts'
import { queryByRepo, type SyncDeps } from './sync.ts'

const READ_TIMEOUT_MS = 10_000

export async function readIssue(deps: SyncDeps, ref: string): Promise<GitHubIssue | undefined> {
  const parsed = parseRef(ref)
  const { issues, failures } = await readIssues(deps, [parsed])
  const issue = issues.get(key(parsed))
  if (issue || failures.length === 0) return issue
  throw new ORPCError('BAD_GATEWAY', {
    message: `could not read ${formatRef(parsed)} from GitHub: ${failures.join('; ')}`,
  })
}

export function parsedOrNull(ref: string): IssueRef | null {
  try {
    return parseRef(ref)
  } catch {
    return null
  }
}

// GitHub は改名前の名前で頼んでも今の名前で返すので、頼んだ名前と番号で引き当てる。
export const key = ({ repo, number }: IssueRef) => `${repo.toLowerCase()}#${number}`

const reason = (error: unknown) => oneLine(error instanceof Error ? error.message : String(error))

/** Track せず、写しにも書かない。失敗した repo の Issue は答えに入らず、理由が `failures` に残る。 */
export async function readIssues(
  deps: SyncDeps,
  refs: IssueRef[],
): Promise<{ issues: Map<string, GitHubIssue>; failures: string[] }> {
  const issues = new Map<string, GitHubIssue>()
  const failures: string[] = []
  if (refs.length === 0) return { issues, failures }
  const signal = deps.signal(READ_TIMEOUT_MS)
  let token: string
  try {
    token = await deps.github.token(signal)
  } catch (error) {
    return { issues, failures: [reason(error)] }
  }
  await queryByRepo({ url: deps.github.url, token }, refs, signal, {
    answered(repo, answer) {
      for (const found of answer.issues) issues.set(key({ repo, number: found.number }), found)
    },
    failed(repo, _, error) {
      failures.push(`${repo}: ${reason(error)}`)
    },
  })
  return { issues, failures }
}
