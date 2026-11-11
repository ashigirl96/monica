import type { ToolResult } from './cleanup.ts'

const ok = (stdout = ''): ToolResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string): ToolResult => ({ code: 1, stdout: '', stderr })
const lines = (items: Iterable<string>) => [...items].map((item) => `${item}\n`).join('')

type DockerKind = 'container' | 'network' | 'volume' | 'image'
type DockerObject = { kind: DockerKind; id: string; labels: Record<string, string> }

const LIST: Record<string, DockerKind> = {
  'ps -aq': 'container',
  'network ls -q': 'network',
  'volume ls -q': 'volume',
  'image ls -q': 'image',
}
const REMOVE: Record<string, DockerKind> = {
  'rm -f': 'container',
  'network rm': 'network',
  'volume rm -f': 'volume',
  'image rm -f': 'image',
}

/** 持っている物を `--filter label=<key>=<value>` で引き、消す偽の docker。 */
export function fakeDocker(objects: DockerObject[], given?: { info?: boolean }) {
  const calls: string[][] = []
  const docker = async (argv: string[]): Promise<ToolResult> => {
    calls.push(argv)
    if (argv[0] === 'info') {
      return given?.info === false ? fail('Cannot connect to the Docker daemon') : ok('Server: x')
    }
    const filterAt = argv.indexOf('--filter')
    const listed = LIST[argv.slice(0, filterAt).join(' ')]
    if (listed) {
      const [key, value] = argv[filterAt + 1]!.replace(/^label=/, '').split(/=(.*)/)
      return ok(
        lines(
          objects.filter((o) => o.kind === listed && o.labels[key!] === value).map((o) => o.id),
        ),
      )
    }
    for (const [command, kind] of Object.entries(REMOVE)) {
      const words = command.split(' ')
      if (argv.slice(0, words.length).join(' ') !== command) continue
      const ids = argv.slice(words.length)
      for (const id of ids) {
        const at = objects.findIndex((o) => o.kind === kind && o.id === id)
        if (at === -1) return fail(`No such ${kind}: ${id}`)
        objects.splice(at, 1)
      }
      return ok(lines(ids))
    }
    return fail(`unknown command: ${argv.join(' ')}`)
  }
  return { docker, calls, objects }
}

/** path ごとの参照と生きた path の集合を持ち、本物の nix-store と同じく答える偽物。 */
export function fakeNixStore(graph: { refs: Record<string, string[]>; live: string[] }) {
  const refs = new Map(Object.entries(graph.refs))
  const live = new Set(graph.live)
  const calls: string[][] = []
  const closure = (paths: string[]) => {
    const found = new Set<string>()
    const visit = (path: string) => {
      if (found.has(path)) return
      found.add(path)
      for (const ref of refs.get(path) ?? []) visit(ref)
    }
    for (const path of paths) visit(path)
    return found
  }
  const nixStore = async (argv: string[]): Promise<ToolResult> => {
    calls.push(argv)
    if (argv[0] === '--delete') {
      const given = argv.slice(1)
      if (given.some((path) => !refs.has(path))) return fail('error: path is not valid')
      const held = given.some(
        (path) =>
          live.has(path) ||
          [...refs].some(([from, to]) => !given.includes(from) && to.includes(path)),
      )
      if (held) return fail('error: cannot delete path because it is still alive')
      for (const path of given) refs.delete(path)
      return ok(`${given.length} store paths deleted`)
    }
    const command = argv.slice(0, 2).join(' ')
    const paths = argv.slice(2)
    const invalid = paths.find((path) => !refs.has(path))
    if (command === '--check-validity --print-invalid') {
      return ok(lines(paths.filter((path) => !refs.has(path))))
    }
    if (command === '--gc --print-dead') {
      return ok(lines([...refs.keys()].filter((path) => !live.has(path))))
    }
    if (invalid) return fail(`error: path '${invalid}' is not valid`)
    if (command === '--query --requisites') return ok(lines(closure(paths)))
    if (command === '--query --referrers') {
      return ok(
        lines([...refs].filter(([, to]) => to.some((ref) => paths.includes(ref))).map(([p]) => p)),
      )
    }
    return fail(`unknown command: ${argv.join(' ')}`)
  }
  return { nixStore, calls, paths: () => [...refs.keys()] }
}
