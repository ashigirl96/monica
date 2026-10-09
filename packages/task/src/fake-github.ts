import type { GitHub } from './github.ts'
import { parseRef } from './ref.ts'

type FakeIssue = {
  title: string
  state?: 'open' | 'closed'
  labels?: string[]
  parent?: string
  blockedBy?: string[]
  closingPullRequests?: string[]
}

type FakePullRequest = {
  title: string
  headRef: string
  /** 省けば、どの repo にも無い commit を指す。 */
  headOid?: string
  state?: 'open' | 'closed' | 'merged'
  isDraft?: boolean
}

const TOKEN = 'fake-token'

const caseless = (ref: string) => ref.toLowerCase()

export function startFakeGitHub() {
  const issues = new Map<string, FakeIssue & { ref: string; id: string }>()
  const pullRequests = new Map<string, FakePullRequest & { ref: string }>()
  const repos = new Map<string, string>()
  const failing = new Set<string>()
  const failingBranches = new Set<string>()
  const requests: { repo: string; numbers: number[]; branches: string[] }[] = []
  let held: Promise<void> | null = null
  let loggedIn = true

  // 改名した repo は旧名でも引ける。
  function find(ref: string) {
    const { repo, number } = parseRef(ref)
    return issues.get(caseless(`${repos.get(caseless(repo)) ?? repo}#${number}`))
  }

  function node(ref: string) {
    const found = find(ref)
    if (!found) throw new Error(`the fake GitHub has no ${ref}`)
    const { repo, number } = parseRef(found.ref)
    return {
      id: found.id,
      number,
      title: found.title,
      state: found.state === 'closed' ? 'CLOSED' : 'OPEN',
      repository: { nameWithOwner: repo },
    }
  }

  // 子は parent から逆引きするので、親と子の対応が食い違わない。
  function subIssuesOf(parentRef: string) {
    const parent = find(parentRef)
    const children = [...issues.values()].filter(
      (child) => child.parent !== undefined && find(child.parent) === parent,
    )
    return {
      total: children.length,
      completed: children.filter((child) => child.state === 'closed').length,
    }
  }

  function labelledNode(ref: string) {
    return {
      ...node(ref),
      labels: { nodes: (find(ref)?.labels ?? []).map((name) => ({ name })) },
      subIssuesSummary: subIssuesOf(ref),
    }
  }

  function pullRequestNode({
    ref,
    title,
    headRef,
    headOid,
    state,
    isDraft,
  }: FakePullRequest & { ref: string }) {
    const { repo, number } = parseRef(ref)
    return {
      number,
      title,
      state: (state ?? 'open').toUpperCase(),
      isDraft: isDraft ?? false,
      headRefName: headRef,
      headRefOid: headOid ?? new Bun.CryptoHasher('sha1').update(ref).digest('hex'),
      repository: { nameWithOwner: repo },
    }
  }

  function closing(ref: string) {
    const found = pullRequests.get(caseless(ref))
    if (!found) throw new Error(`the fake GitHub has no pull request ${ref}`)
    return pullRequestNode(found)
  }

  function headedBy(repo: string, branch: string, states: string[] | null) {
    return [...pullRequests.values()]
      .filter((pr) => caseless(parseRef(pr.ref).repo) === caseless(repo) && pr.headRef === branch)
      .toSorted((a, b) => parseRef(a.ref).number - parseRef(b.ref).number)
      .map(pullRequestNode)
      .filter((pr) => states === null || states.includes(pr.state))
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.headers.get('authorization') !== `bearer ${TOKEN}`) {
        return Response.json({ message: 'Bad credentials' }, { status: 401 })
      }
      const { query, variables } = (await request.json()) as {
        query: string
        variables: { owner: string; name: string }
      }
      const repo = `${variables.owner}/${variables.name}`
      const numbers = [...query.matchAll(/i\d+: issue\(number: (\d+)\)/g)].map((m) => Number(m[1]))
      const branchAliases = [
        ...query.matchAll(
          /(pr\d+): pullRequests\(headRefName: "([^"]+)"(?:, states: \[([A-Z, ]+)\])?/g,
        ),
      ].map((m) => ({ alias: m[1]!, branch: m[2]!, states: m[3]?.split(', ') ?? null }))
      const includeClosedPrs = /closedByPullRequestsReferences\([^)]*includeClosedPrs: true/.test(
        query,
      )
      requests.push({ repo, numbers, branches: branchAliases.map((a) => a.branch) })
      await held
      if (failing.has(caseless(repo))) return new Response('Server Error', { status: 502 })
      const nameWithOwner = repos.get(caseless(repo))
      if (!nameWithOwner) {
        return Response.json({
          data: { repository: null },
          errors: [
            {
              type: 'NOT_FOUND',
              message: `Could not resolve to a Repository with the name '${repo}'.`,
            },
          ],
        })
      }
      const repository: Record<string, unknown> = { nameWithOwner }
      const errors: object[] = []
      for (const number of numbers) {
        const found = find(`${nameWithOwner}#${number}`)
        if (!found) {
          repository[`i${number}`] = null
          errors.push({
            type: 'NOT_FOUND',
            path: ['repository', `i${number}`],
            message: `Could not resolve to an Issue with the number of ${number}.`,
          })
          continue
        }
        repository[`i${number}`] = {
          ...labelledNode(found.ref),
          parent: found.parent ? labelledNode(found.parent) : null,
          blockedBy: { nodes: (found.blockedBy ?? []).map(node) },
          closedByPullRequestsReferences: {
            nodes: (found.closingPullRequests ?? [])
              .map(closing)
              .filter((pr) => includeClosedPrs || pr.state === 'OPEN'),
          },
        }
      }
      for (const { alias, branch, states } of branchAliases) {
        if (failingBranches.has(branch)) {
          repository[alias] = null
          errors.push({ path: ['repository', alias], message: 'Something went wrong' })
          continue
        }
        repository[alias] = { nodes: headedBy(nameWithOwner, branch, states) }
      }
      return Response.json(
        errors.length > 0 ? { data: { repository }, errors } : { data: { repository } },
      )
    },
  })

  const client: GitHub = {
    url: `http://127.0.0.1:${server.port}/graphql`,
    async token() {
      if (!loggedIn) {
        throw new Error('`gh auth token` failed: no oauth token found for github.com')
      }
      return TOKEN
    },
  }

  return {
    client,
    requests,
    issue(ref: string, issue: FakeIssue) {
      repos.set(caseless(parseRef(ref).repo), parseRef(ref).repo)
      const id = issues.get(caseless(ref))?.id ?? `I_${issues.size + 1}`
      issues.set(caseless(ref), { ...issue, ref, id })
    },
    pullRequest(ref: string, pullRequest: FakePullRequest) {
      pullRequests.set(caseless(ref), { ...pullRequest, ref })
    },
    /** その branch を head に持つ PR の query に、null と error で答える。 */
    failBranch(branch: string) {
      failingBranches.add(branch)
    },
    remove(ref: string) {
      issues.delete(caseless(ref))
    },
    removeRepo(repo: string) {
      repos.delete(caseless(repo))
    },
    // 旧名の query も新しい repo に解決する。
    renameRepo(from: string, to: string) {
      // 大小だけの改名は同じ key に入れ直すので、写しを回さないと入れ直した entry をまた訪れる。
      for (const [k, found] of Array.from(issues)) {
        const { repo, number } = parseRef(found.ref)
        if (caseless(repo) !== caseless(from)) continue
        issues.delete(k)
        issues.set(caseless(`${to}#${number}`), { ...found, ref: `${to}#${number}` })
      }
      repos.set(caseless(from), to)
      repos.set(caseless(to), to)
    },
    fail(repo: string) {
      failing.add(caseless(repo))
    },
    logOut() {
      loggedIn = false
    },
    logIn() {
      loggedIn = true
    },
    hold(): () => void {
      let release!: () => void
      held = new Promise((resolve) => (release = resolve))
      return () => {
        held = null
        release()
      }
    },
    stop: () => server.stop(true),
  }
}

export type FakeGitHub = ReturnType<typeof startFakeGitHub>
