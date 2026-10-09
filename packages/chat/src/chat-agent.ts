import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  type Options,
  query,
  type Query,
  type SDKUserMessage,
  startup,
  type WarmQuery,
} from '@anthropic-ai/claude-agent-sdk'

import { type Claude, claudeOptions } from './claude.ts'
import type { AskInput, ChatEvent, SnapshotEvent } from './contract.ts'
import { askContent } from './page/prompt.ts'
import { snapshotOf } from './page/snapshot.ts'
import { singleTurn, userMessage } from './prompt.ts'

// 1 つ 270〜290MB の claude を token の無い口から起こせるので、spare も含めてこの数で止める（ADR-0031）。
const MAX_CLAUDES = 4
const SPARE_LIFETIME_MS = 5 * 60_000

export type ChatAgent = {
  /** 持っている claude すべてに SIGKILL を送る。Backend の exit() は await を挟まずに抜けるので同期にする。 */
  stop(): void
}

type Internals = {
  /** spare の initialize を待たずに返る。 */
  prepare(): void
  /** 空きが無ければ undefined を返す。 */
  ask(
    input: AskInput,
    signal: AbortSignal | undefined,
  ): Promise<AsyncGenerator<ChatEvent> | undefined>
}

// ChatAgent の型は Backend が呼ぶものだけに保ち、procedure が使う中身は ChatAgent を key にここへ置く。
const internalsOf = new WeakMap<ChatAgent, Internals>()

export function internals(chatAgent: ChatAgent): Internals {
  const found = internalsOf.get(chatAgent)
  if (!found) throw new Error('this ChatAgent was not made by createChatAgent')
  return found
}

type Started<T> = { started: T; claude: Claude | undefined }
type Spare = Started<Promise<WarmQuery>> & { timer: ReturnType<typeof setTimeout> }

export function createChatAgent(deps: { home: string; claudePath?: string }): ChatAgent {
  const cwd = join(deps.home, 'chat')
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  // 答えを閉じてから claude が抜けるまでもメモリを食うので、spawn した child の exit で外す。
  const claudes = new Set<Claude>()
  let spare: Spare | undefined

  // SDK は query() と startup() の呼び出しの中で同期に spawn するので、空きを確かめてから呼ぶまでに await を挟まない。
  function spawnWith<T>(start: (options: Options) => T): Started<T> {
    let claude: Claude | undefined
    const started = start(
      claudeOptions({
        cwd,
        claudePath: deps.claudePath,
        spawned: (spawned) => {
          claude = spawned
          claudes.add(spawned)
          const release = () => claudes.delete(spawned)
          spawned.once('exit', release)
          spawned.once('error', release)
        },
      }),
    )
    return { started, claude }
  }

  function prepare() {
    if (spare || claudes.size >= MAX_CLAUDES) return
    const started = spawnWith((options) => startup({ options }))
    // 失敗は ask が spare を使うときに受ける。
    started.started.catch(() => {})
    const timer = setTimeout(() => {
      if (spare !== prepared) return
      spare = undefined
      void prepared.started.then(
        (warm) => warm.close(),
        () => prepared.claude?.kill('SIGKILL'),
      )
    }, SPARE_LIFETIME_MS)
    const prepared: Spare = { ...started, timer }
    spare = prepared
  }

  // 起動中の spare は initialize を待って使い、2 つ目の claude を起こさない。
  async function fromSpare(
    claimed: Spare,
    prompt: AsyncIterable<SDKUserMessage>,
  ): Promise<Started<Query>> {
    const { claude } = claimed
    try {
      const warm = await claimed.started
      if (claude && claude.exitCode === null && claude.signalCode === null) {
        return { started: warm.query(prompt), claude }
      }
      console.error(`[chat] the spare claude ${claude?.pid} has exited; starting another`)
    } catch (error) {
      console.error(
        `[chat] the spare claude ${claude?.pid} did not start: ${(error as Error).message}; starting another`,
      )
      claude?.kill('SIGKILL')
    }
    return spawnWith((options) => query({ prompt, options }))
  }

  async function* answer(
    { started: q, claude }: Started<Query>,
    end: () => void,
    signal: AbortSignal | undefined,
    snapshot: SnapshotEvent,
  ): AsyncGenerator<ChatEvent> {
    // generator の finally は走っている await が終わるまで走らないので、abort ではすぐに送る。
    const kill = () => claude?.kill('SIGKILL')
    signal?.addEventListener('abort', kill)
    if (signal?.aborted) kill()
    let answered = false
    try {
      yield snapshot
      // for await を抜けると SDK は claude の終了を最大 2 秒待つので、result を受けたら iterator を閉じずに返す。
      const messages = q[Symbol.asyncIterator]()
      for (;;) {
        const next = await messages.next()
        if (next.done) return
        const message = next.value
        if (message.type === 'system' && message.subtype === 'init') {
          console.error(
            `[chat] claude ${claude?.pid}: model ${message.model}, ${message.tools.length} tools, ${message.mcp_servers.length} MCP servers`,
          )
        } else if (
          message.type === 'stream_event' &&
          message.event.type === 'content_block_delta' &&
          message.event.delta.type === 'text_delta'
        ) {
          yield { type: 'text', text: message.event.delta.text }
        } else if (message.type === 'result') {
          // Backend の stdout は Shell 宛ての JSON 行だけなので、prompt cache の観察に使う usage は stderr に出す。
          const { usage } = message
          console.error(
            `[chat] claude ${claude?.pid}: usage input ${usage.input_tokens}, cache creation ${usage.cache_creation_input_tokens ?? 0}, cache read ${usage.cache_read_input_tokens ?? 0}, output ${usage.output_tokens}`,
          )
          answered = true
          return
        }
      }
    } finally {
      signal?.removeEventListener('abort', kill)
      // prompt が終わると SDK が stdin を閉じ、答え終えた claude は自分から抜ける。
      end()
      if (answered) {
        prepare()
      } else {
        // abort はたいてい side panel を閉じたときで次の質問は来ないので、spare を起こさない。
        kill()
      }
    }
  }

  const chatAgent: ChatAgent = {
    stop() {
      if (spare) clearTimeout(spare.timer)
      spare = undefined
      for (const claude of claudes) claude.kill('SIGKILL')
    },
  }
  internalsOf.set(chatAgent, {
    prepare,
    async ask({ question, page, history }, signal) {
      // 本文への変換は数百 ms で、spare から答えれば claude を並べて起こす得は小さいので、変換を先に済ませる。
      const snapshot = await snapshotOf(page, history)
      const { content, omitted } = askContent(question, snapshot, history)
      // contract の snapshot の page は screenshot を持たないので、oRPC の output の検証が落とす。
      const event: SnapshotEvent = { type: 'snapshot', page: snapshot, omitted }
      const { prompt, end } = singleTurn(userMessage(content))
      const claimed = spare
      if (claimed) {
        spare = undefined
        clearTimeout(claimed.timer)
        return answer(await fromSpare(claimed, prompt), end, signal, event)
      }
      if (claudes.size >= MAX_CLAUDES) return undefined
      return answer(
        spawnWith((options) => query({ prompt, options })),
        end,
        signal,
        event,
      )
    },
  })
  return chatAgent
}
