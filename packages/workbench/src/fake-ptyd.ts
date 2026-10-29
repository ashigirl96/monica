import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Socket } from 'bun'

import {
  type ProcessInfo,
  PROTOCOL_VERSION,
  type RequestOp,
  type ServerMessage,
  type SessionInfo,
} from './ptyd.ts'

export { writeFakeExecutable } from './fake-executable.ts'

type Frame = RequestOp & { id?: number }
type Connection = {
  decoder: TextDecoder
  buffered: string
  attached: Set<string>
  outbox: Buffer[]
}
type Waiter = { match: (op: RequestOp) => boolean; resolve: (op: RequestOp) => void }

// ptyd の socket の path は macOS で 104 byte を超えると bind できないので、home は短くする。
export function tempHome(register: (cleanup: () => void) => void): string {
  const home = mkdtempSync(join(tmpdir(), 'monica-'))
  register(() => rmSync(home, { recursive: true, force: true }))
  return home
}

// workbench は Create を transaction の後に送るので、Terminal Session は Create の結果が届くまで starting に留まる。
export async function untilSettled<T extends { id: string; status: string }>(
  list: () => Promise<T[]>,
  terminalSessionId: string,
): Promise<T | undefined> {
  for (;;) {
    const found = (await list()).find((s) => s.id === terminalSessionId)
    if (found?.status !== 'starting') return found
    await Bun.sleep(5)
  }
}

export function startFakePtyd(home: string) {
  const sessions: SessionInfo[] = []
  const transcripts = new Map<string, Buffer>()
  const received: RequestOp[] = []
  const waiters: Waiter[] = []
  const holds = new Map<RequestOp['op'], Promise<void>>()
  const sockets = new Set<Socket<Connection>>()
  let nextPid = 1000

  function receivedAll<T extends RequestOp>(match: (op: RequestOp) => op is T): T[]
  function receivedAll(match: (op: RequestOp) => boolean): RequestOp[]
  function receivedAll(match: (op: RequestOp) => boolean): RequestOp[] {
    return received.filter(match)
  }

  // workbench は transaction の後に ptyd へ送るので、要求は後から届く。
  async function receivedAtLeast<T extends RequestOp>(
    count: number,
    match: (op: RequestOp) => op is T,
  ): Promise<T[]>
  async function receivedAtLeast(
    count: number,
    match: (op: RequestOp) => boolean,
  ): Promise<RequestOp[]>
  async function receivedAtLeast(count: number, match: (op: RequestOp) => boolean) {
    while (received.filter(match).length < count) {
      await new Promise((resolve) => waiters.push({ match, resolve }))
    }
    return received.filter(match)
  }

  const fake = {
    sessions,
    output(sessionId: string, bytes: string | Uint8Array) {
      const data = Buffer.from(bytes)
      transcripts.set(
        sessionId,
        Buffer.concat([transcripts.get(sessionId) ?? Buffer.alloc(0), data]).subarray(-262144),
      )
      for (const socket of sockets)
        if (socket.data.attached.has(sessionId))
          send(socket, { type: 'output', session_id: sessionId, data: data.toString('base64') })
    },
    processes: new Map<string, ProcessInfo[]>(),
    beforeList: (): ServerMessage[] => [],
    dropNextList: false,
    dropNextTerminate: false,
    dropNextCreatedReply: false,
    splitListMidCharacter: false,
    beforeCreated: (_op: Extract<RequestOp, { op: 'create' }>): ServerMessage[] => [],
    createError: null as string | null,

    get connections(): number {
      return sockets.size
    },

    received(match: (op: RequestOp) => boolean): Promise<RequestOp> {
      const done = received.find(match)
      if (done) return Promise.resolve(done)
      return new Promise((resolve) => waiters.push({ match, resolve }))
    },

    receivedAll,
    receivedAtLeast,

    // Write の data は base64 なので、打った文字列に戻して返す。
    sessionRequests() {
      return received
        .filter((op): op is Extract<RequestOp, { session_id: string }> => 'session_id' in op)
        .map((op) =>
          op.op === 'write' ? { ...op, data: Buffer.from(op.data, 'base64').toString() } : op,
        )
    },

    // 記録はするので、応答を止めている間も received は解決する。
    holdNext(op: RequestOp['op']): () => void {
      const { promise, resolve } = Promise.withResolvers<void>()
      holds.set(op, promise)
      return resolve
    },

    exit(sessionId: string, exitCode: number | null) {
      const session = sessions.find((s) => s.session_id === sessionId)
      if (session) Object.assign(session, { running: false, pid: null, exit_code: exitCode })
      for (const socket of sockets)
        send(socket, { type: 'exit', session_id: sessionId, exit_code: exitCode })
    },

    // listen は続けるので、Backend はすぐに繋ぎ直す。
    dropConnections() {
      for (const socket of sockets) socket.end()
    },

    stop() {
      server.stop(true)
    },
  }

  function send(socket: Socket<Connection>, message: ServerMessage) {
    socket.data.outbox.push(Buffer.from(`${JSON.stringify(message)}\n`))
    flush(socket)
  }

  function flush(socket: Socket<Connection>) {
    while (socket.data.outbox.length) {
      const bytes = socket.data.outbox[0]!
      const written = socket.write(bytes)
      if (written <= 0) return
      if (written < bytes.length) {
        socket.data.outbox[0] = bytes.subarray(written)
        return
      }
      socket.data.outbox.shift()
    }
  }

  // 間を空けて書くと、client は最初の多 byte 文字の途中で切れた 2 つの chunk として受け取る。
  function sendSplitMidCharacter(socket: Socket<Connection>, message: ServerMessage) {
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`)
    const cut = bytes.findIndex((byte) => byte >= 0x80) + 1
    socket.write(bytes.subarray(0, cut))
    setTimeout(() => socket.write(bytes.subarray(cut)), 20)
  }

  function record(op: RequestOp) {
    received.push(op)
    for (const waiter of waiters.filter((w) => w.match(op))) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(op)
    }
  }

  function handle(socket: Socket<Connection>, { id, ...op }: Frame) {
    // 数でない id の応答は client の待ち手に届かず test が timeout でしか落ちないので、受けた時点で落とす。
    if (id !== undefined && typeof id !== 'number') {
      throw new Error(`a frame to monica-ptyd carries a non-numeric id: ${JSON.stringify(id)}`)
    }
    if (op.op === 'terminate' && fake.dropNextTerminate) {
      fake.dropNextTerminate = false
      return socket.end()
    }
    record(op)
    if (op.op === 'reap') {
      const index = sessions.findIndex((s) => s.session_id === op.session_id)
      if (index >= 0) sessions.splice(index, 1)
    }
    if (op.op === 'resize') {
      const session = sessions.find((item) => item.session_id === op.session_id)
      if (session) Object.assign(session, { rows: op.rows, cols: op.cols })
    }
    if (op.op === 'detach') socket.data.attached.delete(op.session_id)
    if (op.op === 'attach' && id !== undefined) {
      const session = sessions.find((item) => item.session_id === op.session_id)
      if (!session) return send(socket, { type: 'err', id, error: 'no such session' })
      const replay = (transcripts.get(op.session_id) ?? Buffer.alloc(0))
        .subarray(-(op.replay_bytes ?? 262144))
        .toString('base64')
      socket.data.attached.add(op.session_id)
      const response: ServerMessage = {
        type: 'ok',
        id,
        body: 'attached',
        replay,
        rows: session.rows,
        cols: session.cols,
      }
      const hold = holds.get('attach')
      holds.delete('attach')
      if (hold) void hold.then(() => send(socket, response))
      else send(socket, response)
      return
    }
    if (id === undefined) return
    const hold = holds.get(op.op)
    if (!hold) return reply(socket, id, op)
    holds.delete(op.op)
    const snapshot = sessions.map((session) => ({ ...session }))
    void hold.then(() => reply(socket, id, op, snapshot))
  }

  function reply(socket: Socket<Connection>, id: number, op: RequestOp, listed = sessions) {
    switch (op.op) {
      case 'hello':
        return send(socket, { type: 'ok', id, body: 'hello', version: PROTOCOL_VERSION })
      case 'list':
        if (fake.dropNextList) {
          fake.dropNextList = false
          return socket.end()
        }
        for (const message of fake.beforeList()) send(socket, message)
        if (fake.splitListMidCharacter) {
          return sendSplitMidCharacter(socket, {
            type: 'ok',
            id,
            body: 'sessions',
            sessions: listed,
          })
        }
        return send(socket, { type: 'ok', id, body: 'sessions', sessions: listed })
      case 'create': {
        for (const message of fake.beforeCreated(op)) send(socket, message)
        if (fake.createError) return send(socket, { type: 'err', id, error: fake.createError })
        const pid = nextPid++
        sessions.push({
          session_id: op.session_id,
          running: true,
          attached: false,
          pid,
          exit_code: null,
          cwd: op.cwd,
          rows: op.rows,
          cols: op.cols,
        })
        if (fake.dropNextCreatedReply) {
          fake.dropNextCreatedReply = false
          return socket.end()
        }
        return send(socket, { type: 'ok', id, body: 'created', pid })
      }
      case 'processes': {
        const processes = fake.processes.get(op.session_id) ?? []
        return send(socket, { type: 'ok', id, body: 'processes', processes })
      }
      default:
        return send(socket, { type: 'ok', id, body: 'empty' })
    }
  }

  const server = Bun.listen<Connection>({
    unix: join(home, 'ptyd.sock'),
    socket: {
      open(socket) {
        socket.data = { decoder: new TextDecoder(), buffered: '', attached: new Set(), outbox: [] }
        sockets.add(socket)
      },
      data(socket, chunk) {
        socket.data.buffered += socket.data.decoder.decode(chunk, { stream: true })
        let newline = socket.data.buffered.indexOf('\n')
        while (newline >= 0) {
          const line = socket.data.buffered.slice(0, newline).trim()
          socket.data.buffered = socket.data.buffered.slice(newline + 1)
          if (line) handle(socket, JSON.parse(line) as Frame)
          newline = socket.data.buffered.indexOf('\n')
        }
      },
      drain: flush,
      close(socket) {
        sockets.delete(socket)
      },
    },
  })

  return fake
}
