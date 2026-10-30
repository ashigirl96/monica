import { lstatSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname } from 'node:path'

import { TerminalFrameSchema, type TerminalFrame, type TerminalInput } from './remote-terminal.ts'

export type ShellEndpoint = { path: string; secret: string }

export function attachShell(
  endpoint: ShellEndpoint,
  session: string,
  receive: (frame: TerminalFrame) => void,
  lost: () => void,
) {
  for (const path of [dirname(endpoint.path), endpoint.path]) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error('Unprotected Shell socket')
  }
  if (!lstatSync(endpoint.path).isSocket()) throw new Error('Invalid Shell socket')
  const socket = connect(endpoint.path)
  let buffered = Buffer.alloc(0)
  let outstanding: number | undefined
  let next = 1
  let closing = false
  let preparing = false
  let confirmed = false
  let closePromise: Promise<boolean> | undefined
  const completion = Promise.withResolvers<boolean>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const fail = () => {
    socket.destroy()
    lost()
  }
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ secret: endpoint.secret, session })}\n`)
    if (closing) socket.write('{"type":"close"}\n')
    else if (preparing) socket.write('{"type":"prepare"}\n')
  })
  socket.on('data', (chunk) => {
    try {
      buffered = Buffer.concat([buffered, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      if (buffered.length > 1_048_576) throw new Error('Shell queue exceeded')
      for (;;) {
        const newline = buffered.indexOf(10)
        if (newline < 0) {
          if (buffered.length > 65536) throw new Error('Shell frame exceeded')
          break
        }
        if (newline > 65536) throw new Error('Shell frame exceeded')
        const frame = TerminalFrameSchema.parse(
          JSON.parse(buffered.subarray(0, newline).toString()),
        )
        buffered = buffered.subarray(newline + 1)
        if (frame.type === 'closed') {
          confirmed = true
          clearTimeout(timer)
          completion.resolve(true)
          receive(frame)
          socket.end()
          continue
        }
        if (closing) continue
        if (frame.type === 'renderer' || frame.type === 'input_result') {
          receive(frame)
          continue
        }
        if (outstanding !== undefined || frame.sequence !== next++)
          throw new Error('Unordered Shell frame')
        outstanding = frame.sequence
        receive(frame)
      }
    } catch {
      fail()
    }
  })
  socket.on('error', fail)
  socket.on('close', () => {
    if (!confirmed) {
      completion.resolve(false)
      lost()
    }
  })
  return {
    prepare() {
      preparing = true
      if (!closing && !socket.connecting) socket.write('{"type":"prepare"}\n')
    },
    input(command: TerminalInput) {
      const frame = `${JSON.stringify(command)}\n`
      if (
        closing ||
        socket.destroyed ||
        socket.writableLength + Buffer.byteLength(frame) > 1_048_576
      )
        return false
      socket.write(frame)
      return true
    },
    ack(sequence: number) {
      if (closing || outstanding !== sequence) return fail()
      outstanding = undefined
      socket.write(`${JSON.stringify({ type: 'ack', sequence })}\n`)
    },
    close(): Promise<boolean> {
      if (closePromise) return closePromise
      closing = true
      if (!socket.connecting && !socket.destroyed) socket.write('{"type":"close"}\n')
      timer = setTimeout(() => {
        completion.resolve(false)
        socket.destroy()
      }, 2000)
      closePromise = completion.promise.finally(() => clearTimeout(timer))
      return closePromise
    },
    get confirmed() {
      return confirmed
    },
  }
}
export type ShellAttachment = ReturnType<typeof attachShell>
