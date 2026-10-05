import type { GitHub } from './github.ts'
import { parseRef } from './ref.ts'

type FakeIssue = {
  title: string
  state?: 'open' | 'closed'
  labels?: string[]
  parent?: string
  blockedBy?: string[]
}

const TOKEN = 'fake-token'

export function startFakeGitHub() {
  const issues = new Map<string, FakeIssue & { ref: string; id: string }>()
  const repos = new Map<string, string>()
  const failing = new Set<string>()
  const requests: { repo: string; numbers: number[] }[] = []
  let held: Promise<void> | null = null
  let loggedIn = true

  const key = (ref: string) => ref.toLowerCase()

  // 改名した repo は旧名でも引ける。
  function find(ref: string) {
    const { repo, number } = parseRef(ref)
    return issues.get(key(`${repos.get(key(repo)) ?? repo}#${number}`))
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
      requests.push({ repo, numbers })
      await held
      if (failing.has(key(repo))) return new Response('Server Error', { status: 502 })
      const nameWithOwner = repos.get(key(repo))
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
          ...node(found.ref),
          labels: { nodes: (found.labels ?? []).map((name) => ({ name })) },
          parent: found.parent ? node(found.parent) : null,
          blockedBy: { nodes: (found.blockedBy ?? []).map(node) },
        }
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
      repos.set(key(parseRef(ref).repo), parseRef(ref).repo)
      const id = issues.get(key(ref))?.id ?? `I_${issues.size + 1}`
      issues.set(key(ref), { ...issue, ref, id })
    },
    remove(ref: string) {
      issues.delete(key(ref))
    },
    removeRepo(repo: string) {
      repos.delete(key(repo))
    },
    // 旧名の query も新しい repo に解決する。
    renameRepo(from: string, to: string) {
      for (const [k, found] of issues) {
        const { repo, number } = parseRef(found.ref)
        if (key(repo) !== key(from)) continue
        issues.delete(k)
        issues.set(key(`${to}#${number}`), { ...found, ref: `${to}#${number}` })
      }
      repos.set(key(from), to)
      repos.set(key(to), to)
    },
    fail(repo: string) {
      failing.add(key(repo))
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
