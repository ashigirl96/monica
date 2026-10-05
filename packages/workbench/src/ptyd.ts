import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Socket } from 'bun'

export const PROTOCOL_VERSION = 1

export type SessionInfo = {
  session_id: string
  running: boolean
  attached: boolean
  pid: number | null
  exit_code: number | null
  cwd: string
  rows: number
  cols: number
}

export type RequestOp =
  | { op: 'hello'; version: number }
  | {
      op: 'create'
      session_id: string
      cwd: string
      shell: string | null
      rows: number
      cols: number
      env: [string, string][] | null
    }
  | { op: 'write'; session_id: string; data: string }
  | { op: 'terminate'; session_id: string }
  | { op: 'list' }
  | { op: 'reap'; session_id: string }
  | { op: 'shutdown' }

export type ResponseBody =
  | { body: 'empty' }
  | { body: 'hello'; version: number }
  | { body: 'created'; pid: number | null }
  | { body: 'sessions'; sessions: SessionInfo[] }

export type ServerMessage =
  | ({ type: 'ok'; id: number } & ResponseBody)
  | { type: 'err'; id: number; error: string }
  | { type: 'output'; session_id: string; data: string }
  | { type: 'exit'; session_id: string; exit_code: number | null }

export type PtydHandlers = {
  onExit: (sessionId: string, exitCode: number | null) => void
  onClose: () => void
}

// 接続が切れた要求は ptyd が受け取ったかが分からないので、断られたのと分けて返す。
export type Outcome<T> =
  | { kind: 'done'; value: T }
  | { kind: 'refused'; error: string }
  | { kind: 'unknown' }

class Disconnected extends Error {}

export class PtydClient {
  private socket: Socket
  private handlers: PtydHandlers
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (b: ResponseBody) => void; reject: (e: Error) => void }
  >()
  // chunk の境目で多 byte 文字が割れても、続きの chunk まで持ち越して decode する。
  private decoder = new TextDecoder()
  private buffered = ''
  private outbox: Uint8Array[] = []
  private closed = false

  private constructor(socket: Socket, handlers: PtydHandlers) {
    this.socket = socket
    this.handlers = handlers
  }

  static async connect(socketPath: string, handlers: PtydHandlers): Promise<PtydClient> {
    let client!: PtydClient
    const socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          client.receive(chunk)
        },
        drain() {
          client.flush()
        },
        close() {
          client.shutdown('tania-ptyd connection closed')
        },
        error(_s, error) {
          client.shutdown(error.message)
        },
      },
    })
    client = new PtydClient(socket, handlers)
    return client
  }

  async hello(): Promise<number> {
    const body = await this.request({ op: 'hello', version: PROTOCOL_VERSION })
    if (body.body !== 'hello') throw new Error(`unexpected hello response: ${body.body}`)
    return body.version
  }

  async list(): Promise<SessionInfo[]> {
    const body = await this.request({ op: 'list' })
    if (body.body !== 'sessions') throw new Error(`unexpected list response: ${body.body}`)
    return body.sessions
  }

  create(op: Omit<Extract<RequestOp, { op: 'create' }>, 'op'>): Promise<Outcome<number | null>> {
    return this.outcome({ op: 'create', ...op }, (body) => {
      if (body.body !== 'created') throw new Error(`unexpected create response: ${body.body}`)
      return body.pid
    })
  }

  // ptyd は attach していない接続からの Write も通すので、webview が Tab を表示していなくても打てる。
  write(sessionId: string, data: string): Promise<Outcome<void>> {
    const encoded = Buffer.from(data).toString('base64')
    return this.outcome({ op: 'write', session_id: sessionId, data: encoded }, () => {})
  }

  terminate(sessionId: string): Promise<Outcome<void>> {
    return this.outcome({ op: 'terminate', session_id: sessionId }, () => {})
  }

  reap(sessionId: string) {
    this.notify({ op: 'reap', session_id: sessionId })
  }

  shutdownDaemon() {
    this.notify({ op: 'shutdown' })
  }

  private async outcome<T>(op: RequestOp, read: (body: ResponseBody) => T): Promise<Outcome<T>> {
    try {
      return { kind: 'done', value: read(await this.request(op)) }
    } catch (error) {
      if (error instanceof Disconnected) return { kind: 'unknown' }
      return { kind: 'refused', error: error instanceof Error ? error.message : String(error) }
    }
  }

  private request(op: RequestOp): Promise<ResponseBody> {
    if (this.closed) return Promise.reject(new Disconnected('tania-ptyd connection closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // op に紛れた id が要求の id を上書きすると応答が待ち手に届かないので、id を最後に置く。
      this.send({ ...op, id })
    })
  }

  private notify(op: RequestOp) {
    if (!this.closed) this.send(op)
  }

  isClosed(): boolean {
    return this.closed
  }

  close() {
    this.socket.end()
  }

  setHandlers(handlers: PtydHandlers) {
    this.handlers = handlers
    if (this.closed) handlers.onClose()
  }

  private send(frame: object) {
    this.outbox.push(new TextEncoder().encode(`${JSON.stringify(frame)}\n`))
    this.flush()
  }

  // Bun の socket.write は chunk の一部しか書かないことがあり、残りは drain で送る。
  private flush() {
    while (this.outbox.length > 0) {
      const chunk = this.outbox[0]!
      const written = this.socket.write(chunk)
      if (written < chunk.byteLength) {
        this.outbox[0] = chunk.subarray(Math.max(written, 0))
        return
      }
      this.outbox.shift()
    }
  }

  private receive(chunk: Buffer) {
    this.buffered += this.decoder.decode(chunk, { stream: true })
    let newline = this.buffered.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline).trim()
      this.buffered = this.buffered.slice(newline + 1)
      if (line) this.dispatch(JSON.parse(line) as ServerMessage)
      newline = this.buffered.indexOf('\n')
    }
  }

  private dispatch(message: ServerMessage) {
    switch (message.type) {
      case 'ok':
      case 'err': {
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id)
        if (message.type === 'ok') waiter.resolve(message)
        else waiter.reject(new Error(message.error))
        return
      }
      case 'exit':
        this.handlers.onExit(message.session_id, message.exit_code)
        return
      case 'output':
        return
    }
  }

  private shutdown(reason: string) {
    if (this.closed) return
    this.closed = true
    const error = new Disconnected(reason)
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
    this.handlers.onClose()
  }
}

export type DaemonPaths = { home: string; ptydPath: string }

const socketPath = (home: string) => join(home, 'ptyd.sock')
const pidPath = (home: string) => join(home, 'ptyd.pid')

/**
 * Backend だけの env を落とした env。Claude Code の中から起こした Backend の CLAUDECODE が
 * Tab に漏れると、claude wrapper が入れ子と誤認する。
 */
export function inheritableEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('TANIA_') || key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue
    env[key] = value
  }
  return env
}

// ptyd は自分の env を全 tab に渡すので、Backend だけの env を落とす。
function daemonEnv(home: string): Record<string, string> {
  return { ...inheritableEnv(), TANIA_HOME: home }
}

function spawnDaemon({ home, ptydPath }: DaemonPaths) {
  if (!existsSync(ptydPath)) throw new Error(`tania-ptyd not found at ${ptydPath}`)
  // ptyd は setsid と SIGHUP の無視で自分を切り離すので、起こした Backend より長生きする。
  const child = Bun.spawn([ptydPath, '--tania-home', home], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: daemonEnv(home),
  })
  child.unref()
}

async function connectWithin(socket: string, handlers: PtydHandlers, windowMs: number) {
  const deadline = Date.now() + windowMs
  for (;;) {
    try {
      return await PtydClient.connect(socket, handlers)
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await Bun.sleep(50)
    }
  }
}

function killDaemonFromPidFile(home: string) {
  try {
    const pid = Number.parseInt(readFileSync(pidPath(home), 'utf8').trim(), 10)
    if (Number.isFinite(pid)) process.kill(pid, 'SIGTERM')
  } catch {
    // pid file が無いか、もう居ない。
  }
}

const silent: PtydHandlers = { onExit() {}, onClose() {} }

// 入れ替えで消えた session を lost にする経路はここに持たない。消えた session は List に現れず、
// handlers を付ける前に届いた Exit は tombstone として List に残るので、繋いだ後の reconcile で足りる。
export async function openDaemon(paths: DaemonPaths, handlers: PtydHandlers): Promise<PtydClient> {
  const socket = socketPath(paths.home)
  let client: PtydClient
  try {
    client = await PtydClient.connect(socket, silent)
  } catch {
    spawnDaemon(paths)
    client = await connectWithin(socket, silent, 2000)
  }
  const version = await client.hello()
  if (version !== PROTOCOL_VERSION) {
    console.error(
      `[workbench] tania-ptyd speaks protocol ${version} (want ${PROTOCOL_VERSION}); replacing it`,
    )
    client.shutdownDaemon()
    await Bun.sleep(300)
    killDaemonFromPidFile(paths.home)
    spawnDaemon(paths)
    client = await connectWithin(socket, silent, 2000)
    const replacedVersion = await client.hello()
    if (replacedVersion !== PROTOCOL_VERSION) {
      throw new Error(`tania-ptyd still speaks protocol ${replacedVersion} after restart`)
    }
  }
  client.setHandlers(handlers)
  return client
}
