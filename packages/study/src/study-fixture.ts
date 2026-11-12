import { Database } from 'bun:sqlite'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { createRouterClient } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { migrations } from '../migrations/index.ts'
import type { Query } from './claude.ts'
import type { Tools } from './cleanup.ts'
import type { StudyWatchEvent } from './contract.ts'
import { createStudyLedger, router } from './server.ts'

const noop = () => {}

export async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await Bun.sleep(5)
}

export type FakeClaude = {
  options: Options
  prompts: string[]
  pid: number
  emit(...messages: object[]): void
  exited: Promise<void>
  interrupts: number
}

// 本物の process を持ち、台本の SDK の message を返す。テストが emit で続きを流し、process が居なくなると message が尽きる。
function fakeQuery() {
  const fake = {
    shell: 'sleep 60 & wait',
    claudes: [] as FakeClaude[],
    query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const queued: object[] = []
      let wake: () => void = noop
      let gone = false
      const child = options.spawnClaudeCodeProcess!({
        command: '/bin/sh',
        args: ['-c', fake.shell],
        cwd: options.cwd!,
        env: options.env!,
        signal: new AbortController().signal,
      }) as ChildProcess
      const claude: FakeClaude = {
        options,
        prompts: [],
        pid: child.pid!,
        emit(...messages) {
          queued.push(...messages)
          wake()
        },
        interrupts: 0,
        exited: new Promise((resolve) =>
          child.once('exit', () => {
            gone = true
            wake()
            resolve()
          }),
        ),
      }
      void (async () => {
        for await (const message of prompt) claude.prompts.push(message.message.content as string)
      })()
      fake.claudes.push(claude)
      const messages = (async function* () {
        for (;;) {
          const next = queued.shift()
          if (next) yield next
          else if (gone) return
          else await new Promise<void>((resolve) => (wake = resolve))
        }
      })()
      // 本物の interrupt() も、止めた turn を result で閉じる。
      return Object.assign(messages, {
        interrupt: async () => {
          claude.interrupts++
          claude.emit(result('interrupted'))
        },
      })
    }) as unknown as Query,
  }
  return fake
}

export const init = (sessionId = 'session-1') => ({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
})
export const delta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
})
export const said = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
export const toolUse = (id: string, name: string, input: object) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
})
export const toolResult = (id: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
})
export const result = (error?: string) => ({
  type: 'result',
  subtype: 'success',
  is_error: error !== undefined,
  result: error ?? '',
})

export function inMemoryDb() {
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  return db
}

export const shape = (event: StudyWatchEvent) => {
  if (event.type === 'message') return `${event.message.kind}:${event.message.text}`
  if (event.type === 'delta') return `delta:${event.text}`
  if (event.type === 'turn-ended') return `turn-ended:${event.error}`
  if (event.type === 'conversation-ended') return `conversation-ended:${event.conversationId}`
  return event.type
}

/** 片付けは呼び手の test file の hook が cleanups を回す。 */
export function studyFixture(cleanups: (() => unknown)[]) {
  function setup(given?: {
    db?: ReturnType<typeof inMemoryDb>
    home?: string
    tutorsDir?: string
    tools?: Tools
  }) {
    const home = given?.home ?? mkdtempSync(join(tmpdir(), 'monica-study-'))
    const db = given?.db ?? inMemoryDb()
    const fake = fakeQuery()
    const deletedSessions: { sessionId: string; dir: string | undefined }[] = []
    const studyLedger = createStudyLedger({
      db,
      home,
      query: fake.query,
      tutorsDir: given?.tutorsDir,
      openInEditor: async () => {},
      // 既定の tools は手元の本物の docker と nix-store を呼ぶ。
      tools: given?.tools ?? { docker: null, nixStore: null },
      // 既定は手元の ~/.claude/projects/ の記録を消す。
      deleteSession: async (sessionId, options) => {
        deletedSessions.push({ sessionId, dir: options?.dir })
      },
    })
    const client = createRouterClient(router, { context: { db, studyLedger } })
    cleanups.push(async () => {
      studyLedger.stop()
      await Promise.all(fake.claudes.map((claude) => claude.exited))
      if (!given?.home) rmSync(home, { recursive: true, force: true })
    })
    return { home, db, fake, client, studyLedger, deletedSessions }
  }

  async function watching(client: ReturnType<typeof setup>['client'], id: string) {
    const closed = new AbortController()
    const iterator = await client.watch({ id }, { signal: closed.signal })
    const events: StudyWatchEvent[] = []
    void (async () => {
      try {
        for await (const event of iterator) events.push(event)
      } catch {}
    })()
    cleanups.push(() => closed.abort())
    return {
      events,
      close: () => closed.abort(),
      until: (predicate: (event: StudyWatchEvent) => boolean) =>
        until(() => events.some(predicate)),
      ended: () => until(() => events.some((event) => event.type === 'turn-ended')),
    }
  }

  return { setup, watching }
}
