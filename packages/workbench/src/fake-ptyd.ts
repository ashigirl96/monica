import { join } from 'node:path'

import type { Socket } from 'bun'

import { PROTOCOL_VERSION, type RequestOp, type ServerMessage, type SessionInfo } from './ptyd.ts'

type Frame = RequestOp & { id?: number }
type Connection = { decoder: TextDecoder; buffered: string }
type Waiter = { match: (op: RequestOp) => boolean; resolve: (op: RequestOp) => void }

export function startFakePtyd(home: string) {
  const sessions: SessionInfo[] = []
  const received: RequestOp[] = []
  const waiters: Waiter[] = []
  const sockets = new Set<Socket<Connection>>()
  let nextPid = 1000

  const fake = {
    sessions,
    beforeList: (): ServerMessage[] => [],
    dropNextList: false,
    dropNextTerminate: false,
    dropNextCreatedReply: false,
    splitListMidCharacter: false,
    beforeCreated: (_op: Extract<RequestOp, { op: 'create' }>): ServerMessage[] => [],
    createError: null as string | null,
    writeError: null as string | null,

    get connections(): number {
      return sockets.size
    },

    received(match: (op: RequestOp) => boolean): Promise<RequestOp> {
      const done = received.find(match)
      if (done) return Promise.resolve(done)
      return new Promise((resolve) => waiters.push({ match, resolve }))
    },

    receivedAll(match: (op: RequestOp) => boolean): RequestOp[] {
      return received.filter(match)
    },

    exit(sessionId: string, exitCode: number | null) {
      const session = sessions.find((s) => s.session_id === sessionId)
      if (session) Object.assign(session, { running: false, pid: null, exit_code: exitCode })
      for (const socket of sockets)
        send(socket, { type: 'exit', session_id: sessionId, exit_code: exitCode })
    },

    stop() {
      server.stop(true)
    },
  }

  function send(socket: Socket<Connection>, message: ServerMessage) {
    socket.write(`${JSON.stringify(message)}\n`)
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
      throw new Error(`a frame to tania-ptyd carries a non-numeric id: ${JSON.stringify(id)}`)
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
    if (id === undefined) return
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
          return sendSplitMidCharacter(socket, { type: 'ok', id, body: 'sessions', sessions })
        }
        return send(socket, { type: 'ok', id, body: 'sessions', sessions })
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
      case 'write':
        if (fake.writeError) return send(socket, { type: 'err', id, error: fake.writeError })
        return send(socket, { type: 'ok', id, body: 'empty' })
      default:
        return send(socket, { type: 'ok', id, body: 'empty' })
    }
  }

  const server = Bun.listen<Connection>({
    unix: join(home, 'ptyd.sock'),
    socket: {
      open(socket) {
        socket.data = { decoder: new TextDecoder(), buffered: '' }
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
      close(socket) {
        sockets.delete(socket)
      },
    },
  })

  return fake
}
