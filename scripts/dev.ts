import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

type Process = { pid: number; ppid: number; command: string }

type Dev = {
  name: string
  home: string
  desktop?: number
  backend?: number
  ptyd?: number
  bridgePort?: string
  repo?: string
}

const userHome = homedir()
const releaseHome = join(userHome, '.tania')
const scratch = tmpdir()

function processes(): Map<number, Process> {
  const ps = Bun.spawnSync(['ps', '-axwwo', 'pid=,ppid=,command=']).stdout.toString()
  const table = new Map<number, Process>()
  for (const line of ps.split('\n')) {
    const [, pid, ppid, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/) ?? []
    if (pid && ppid && command)
      table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), command })
  }
  return table
}

function lsofNames(pid: number, ...filters: string[]): string[] {
  const lsof = Bun.spawnSync(['lsof', '-a', '-p', String(pid), ...filters, '-Fn'])
  return [...lsof.stdout.toString().matchAll(/^n(.+)$/gm)]
    .map(([, name]) => name)
    .filter((name) => name !== undefined)
}

function cwdOf(pid: number): string | undefined {
  return lsofNames(pid, '-d', 'cwd')[0]
}

// debug の desktop が listen するのは tauri-plugin-mcp-bridge だけ。
function bridgePortOf(desktop: number): string | undefined {
  const addresses = lsofNames(desktop, '-iTCP', '-sTCP:LISTEN', '-P', '-n')
  return addresses.length > 0 ? addresses.map((a) => a.split(':').at(-1)).join(',') : undefined
}

// ptyd は <repo>/target/debug/tania-ptyd。headless の Backend は相対 path で起こすので cwd から解く。
function repoOf(ptydBinary: string, pid: number): string | undefined {
  const cwd = isAbsolute(ptydBinary) ? '/' : cwdOf(pid)
  return cwd && dirname(dirname(dirname(resolve(cwd, ptydBinary))))
}

function entriesWithPrefix(dir: string, prefix: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.startsWith(prefix))
        .map((name) => join(dir, name))
    : []
}

function homesOnDisk(): string[] {
  return [
    ...entriesWithPrefix(userHome, '.tania-'),
    ...entriesWithPrefix(scratch, 'tania-'),
  ].filter((home) => ['tania.db', 'ptyd.pid'].some((file) => existsSync(join(home, file))))
}

// 落ちた Backend の backend.json は残り、その pid が別の process に使い回されていることがある。
function backendOf(home: string, procs: Map<number, Process>): number | undefined {
  try {
    const { pid } = JSON.parse(readFileSync(join(home, 'backend.json'), 'utf8')) as { pid: number }
    return procs.get(pid)?.command.includes('apps/backend/src/main.ts') ? pid : undefined
  } catch {
    return undefined
  }
}

function devs(): Dev[] {
  const procs = processes()
  const byHome = new Map<string, Dev>()
  const devAt = (home: string) => {
    const dev = byHome.get(home) ?? { name: basename(home), home }
    byHome.set(home, dev)
    return dev
  }
  for (const proc of procs.values()) {
    const [, binary, home] = proc.command.match(/^(\S*tania-ptyd) --tania-home (.+)$/) ?? []
    if (!binary || !home || home === releaseHome) continue
    const dev = devAt(home)
    dev.ptyd = proc.pid
    dev.repo = repoOf(binary, proc.pid)
  }
  for (const home of homesOnDisk()) devAt(home)
  for (const dev of byHome.values()) {
    dev.backend = backendOf(dev.home, procs)
    const parent = procs.get(procs.get(dev.backend ?? -1)?.ppid ?? -1)
    if (parent?.command.includes('target/debug/tania-desktop')) {
      dev.desktop = parent.pid
      dev.bridgePort = bridgePortOf(parent.pid)
    }
  }
  return [...byHome.values()].toSorted((a, b) => a.name.localeCompare(b.name))
}

function kind(dev: Dev): string {
  if (dev.desktop) return 'desktop'
  if (dev.backend) return 'headless'
  return dev.ptyd ? 'ptyd' : '-'
}

function worktree(repo: string | undefined): string {
  if (!repo) return '-'
  return repo.match(/\/\.worktrees\/([^/]+)$/)?.[1] ?? basename(repo)
}

function list(all: Dev[]) {
  if (all.length === 0) {
    console.log('dev はありません')
    return
  }
  const header = ['NAME', 'KIND', 'DESKTOP', 'BACKEND', 'PTYD', 'BRIDGE', 'WORKTREE']
  const rows = [
    header,
    ...all.map((dev) => [
      dev.name,
      kind(dev),
      String(dev.desktop ?? '-'),
      String(dev.backend ?? '-'),
      String(dev.ptyd ?? '-'),
      dev.bridgePort ?? '-',
      worktree(dev.repo),
    ]),
  ]
  const widths = header.map((_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0)))
  for (const row of rows) {
    console.log(
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    )
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stop(pid: number) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(100)
  if (alive(pid)) process.kill(pid, 'SIGKILL')
}

async function kill(name: string | undefined, all: Dev[]) {
  const dev = all.find((d) => d.name === name || d.home === name)
  if (!dev) {
    console.error(name ? `${name} という dev はありません` : '止める dev の NAME を渡してください')
    list(all)
    process.exit(1)
  }
  // 親から止める。Shell は落ちた Backend を、Backend は居なくなった ptyd を起こし直す。
  const order = [
    ['desktop', dev.desktop],
    ['backend', dev.backend],
    ['ptyd', dev.ptyd],
  ] as const
  for (const [role, pid] of order) {
    if (pid === undefined) continue
    await stop(pid)
    console.log(`${role} (${pid}) を止めた`)
  }
  if (dev.home.startsWith(`${scratch}/`)) {
    rmSync(dev.home, { recursive: true, force: true })
    console.log(`${dev.home} を消した`)
  } else {
    console.log(`${dev.home} は残した`)
  }
}

const [command, name] = process.argv.slice(2)
if (command === 'list') {
  list(devs())
} else if (command === 'kill') {
  await kill(name, devs())
} else {
  console.error('使い方: bun run dev:list / bun run dev:kill <NAME>')
  process.exit(1)
}
