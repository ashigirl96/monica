import { z } from 'zod'

import type { IssueRef } from './ref.ts'
import type { issue, pullRequest } from './schema.ts'

export type GitHub = {
  url: string
  token: (signal: AbortSignal) => Promise<string>
}

export const defaultGitHub: GitHub = { url: 'https://api.github.com/graphql', token: ghAuthToken }

const ghAuthTokenFailed = (reason: string) =>
  new Error(`\`gh auth token\` failed: ${reason}; run \`gh auth login\``)

// gh の token は gh auth login / refresh で変わるので、process の寿命の間 cache しない。
export async function ghAuthToken(signal: AbortSignal): Promise<string> {
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    // env を渡さないと Bun は起動時の PATH で gh を探すので、Backend が login shell から入れた PATH が効かない。
    child = Bun.spawn(['gh', 'auth', 'token', '--hostname', 'github.com'], {
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
    })
  } catch (error) {
    throw ghAuthTokenFailed(error instanceof Error ? error.message : String(error))
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  signal.throwIfAborted()
  const token = stdout.trim()
  if (exitCode !== 0) throw ghAuthTokenFailed(oneLine(stderr) || `exit ${exitCode}`)
  if (!token) throw ghAuthTokenFailed('it printed no token')
  return token
}

export type LinkedIssue = IssueRef & { nodeId: string } & Pick<
    typeof issue.$inferSelect,
    'title' | 'state'
  >

export type GitHubPullRequest = IssueRef &
  Pick<typeof pullRequest.$inferSelect, 'title' | 'state' | 'isDraft' | 'headRef' | 'headOid'>

/** PR の並びが null なら GitHub が答えなかったので、前の対応を残す。 */
export type GitHubIssue = LinkedIssue & {
  labels: string[]
  parent: LinkedIssue | null
  blockers: LinkedIssue[]
  closingPullRequests: GitHubPullRequest[] | null
  branchPullRequests: GitHubPullRequest[] | null
}

export type AskedIssue = { number: number; benchBranch: string | null }

export type IssuesAnswer = { issues: GitHubIssue[]; missing: IssueRef[] }

export class RepositoryNotFound extends Error {}

// GitHub の query 1 本あたりの node の上限に収まり、repo の Task を数本の往復にまとめられる数。
export const BATCH = 50

const State = z.enum(['OPEN', 'CLOSED']).transform((s) => (s === 'OPEN' ? 'open' : 'closed'))

const LinkedNode = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  state: State,
  repository: z.object({ nameWithOwner: z.string() }),
})

const PullRequestNode = z.object({
  number: z.number(),
  title: z.string(),
  state: z
    .enum(['OPEN', 'CLOSED', 'MERGED'])
    .transform((s) => s.toLowerCase() as Lowercase<typeof s>),
  isDraft: z.boolean(),
  headRefName: z.string(),
  // git の引数に渡すので、object の名前の形だけを通す。
  headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/),
  repository: z.object({ nameWithOwner: z.string() }),
})

const PullRequests = z.object({ nodes: z.array(PullRequestNode.nullable()) }).nullish()

const IssueNode = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  state: State,
  labels: z.object({ nodes: z.array(z.object({ name: z.string() }).nullable()) }),
  parent: LinkedNode.nullable(),
  blockedBy: z.object({ nodes: z.array(LinkedNode.nullable()) }),
  closedByPullRequestsReferences: PullRequests,
})

const GraphQLResponse = z.object({
  data: z.object({ repository: z.looseObject({ nameWithOwner: z.string() }).nullable() }).nullish(),
  errors: z.array(z.object({ message: z.string() })).optional(),
})

export async function queryIssues(
  { url, token }: { url: string; token: string },
  repo: string,
  asked: AskedIssue[],
  signal: AbortSignal,
): Promise<IssuesAnswer> {
  const [owner, name] = repo.split('/')
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'monica',
    },
    body: JSON.stringify({ query: issuesQuery(asked), variables: { owner, name } }),
    signal,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub answered ${response.status}: ${oneLine(text)}`)
  const body = GraphQLResponse.parse(JSON.parse(text))
  const reason = () => body.errors?.map((e) => e.message).join('; ')
  if (!body.data) throw new Error(reason() || 'GitHub returned no data')
  // repo ごと返らないのは多くが権限の喪失（gh のアカウント違い・SSO）で、写しが黙って古くなるので失敗にする。
  const repository = body.data.repository
  if (!repository) throw new RepositoryNotFound(reason() || `GitHub could not resolve ${repo}`)
  const issues: GitHubIssue[] = []
  const missing: IssueRef[] = []
  for (const { number, benchBranch } of asked) {
    const node = repository[`i${number}`]
    if (!node) {
      missing.push({ repo, number })
      continue
    }
    const parsed = IssueNode.parse(node)
    issues.push({
      nodeId: parsed.id,
      repo: repository.nameWithOwner,
      number: parsed.number,
      title: parsed.title,
      state: parsed.state,
      labels: parsed.labels.nodes.flatMap((label) => (label ? [label.name] : [])),
      parent: parsed.parent && linked(parsed.parent),
      blockers: parsed.blockedBy.nodes.flatMap((blocker) => (blocker ? [linked(blocker)] : [])),
      closingPullRequests: pullRequestsOf(parsed.closedByPullRequestsReferences),
      // worktree の Bench が無ければ、head が一致する branch も無い。
      branchPullRequests:
        benchBranch === null ? [] : pullRequestsOf(PullRequests.parse(repository[`pr${number}`])),
    })
  }
  return { issues, missing }
}

function pullRequestsOf(connection: z.infer<typeof PullRequests>): GitHubPullRequest[] | null {
  if (!connection) return null
  return connection.nodes.flatMap((node) =>
    node
      ? [
          {
            repo: node.repository.nameWithOwner,
            number: node.number,
            title: node.title,
            state: node.state,
            isDraft: node.isDraft,
            headRef: node.headRefName,
            headOid: node.headRefOid,
          },
        ]
      : [],
  )
}

function linked(node: z.infer<typeof LinkedNode>): LinkedIssue {
  return {
    nodeId: node.id,
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    state: node.state,
  }
}

// GitHub は blockedBy を 50 件までしか張らせないので、1 ページで全部が返る。
function issuesQuery(asked: AskedIssue[]): string {
  const aliases = asked.flatMap(({ number: n, benchBranch }) => [
    `    i${n}: issue(number: ${n}) { ...Copied }`,
    ...(benchBranch === null
      ? []
      : [
          `    pr${n}: pullRequests(headRefName: ${JSON.stringify(benchBranch)}, states: [OPEN, CLOSED, MERGED], first: 10) { nodes { ...CopiedPullRequest } }`,
        ]),
  ])
  return `query MonicaIssues($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
${aliases.join('\n')}
  }
}
fragment Copied on Issue {
  id number title state
  labels(first: 100) { nodes { name } }
  parent { ...Linked }
  blockedBy(first: 50) { nodes { ...Linked } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { ...CopiedPullRequest } }
}
fragment Linked on Issue { id number title state repository { nameWithOwner } }
fragment CopiedPullRequest on PullRequest {
  number title state isDraft headRefName headRefOid repository { nameWithOwner }
}
`
}

export function oneLine(text: string): string {
  return text.trim().replaceAll(/\s*\n\s*/g, ' ')
}
