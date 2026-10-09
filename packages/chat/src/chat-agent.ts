import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  type Options,
  query,
  type Query,
  type SDKAssistantMessage,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
  startup,
  type WarmQuery,
} from '@anthropic-ai/claude-agent-sdk'

import { type Claude, claudeOptions, stderrTail } from './claude.ts'
import type { AskInput, ChatEvent, SnapshotEvent } from './contract.ts'
import { askContent } from './page/prompt.ts'
import { defaultReaders, type Readers, snapshotOf } from './page/snapshot.ts'
import { singleTurn, userMessage } from './prompt.ts'

// 1 つ 270〜290MB の claude を token の無い口から起こせるので、spare も含めてこの数で止める（ADR-0031）。
const MAX_CLAUDES = 4
const SPARE_LIFETIME_MS = 5 * 60_000
// side panel は detail をそのまま詳しい行に出すので、長い stderr で画面を埋めない。
const MAX_DETAIL_CHARS = 2000

const NOT_AUTHENTICATED_ERRORS: SDKAssistantMessageError[] = [
  'authentication_failed',
  'oauth_org_not_allowed',
  'verification_required',
]

/** claude が答えを返せなかった理由。server の handler が chat.ask の `.errors()` の typed error にする。 */
export type Failure =
  | { code: 'NOT_AUTHENTICATED' }
  | { code: 'USAGE_LIMIT'; data: { rateLimitType: string; resetsAt: number } }
  | { code: 'AGENT_FAILED'; data: { detail: string } }

export class ChatFailure extends Error {
  readonly failure: Failure

  constructor(failure: Failure) {
    super(failure.code)
    this.failure = failure
  }
}

export function agentFailed(detail: string): ChatFailure {
  return new ChatFailure({
    code: 'AGENT_FAILED',
    data: { detail: detail.slice(0, MAX_DETAIL_CHARS) },
  })
}

async function withStderr(message: string, claude: Claude | undefined): Promise<string> {
  const stderr = claude ? (await stderrTail(claude)).trim() : ''
  return stderr ? `${message}\n${stderr}` : message
}

// 上限の header の無い 429 も rejected になるが resetsAt を持たないので、plan の上限とは resetsAt の有無で分ける。
function failureOf(
  result: SDKResultMessage,
  rateLimit: SDKRateLimitInfo | undefined,
  assistantError: SDKAssistantMessageError | undefined,
): ChatFailure {
  if (
    rateLimit?.status === 'rejected' &&
    rateLimit.resetsAt !== undefined &&
    rateLimit.rateLimitType !== undefined
  ) {
    const { rateLimitType, resetsAt } = rateLimit
    return new ChatFailure({ code: 'USAGE_LIMIT', data: { rateLimitType, resetsAt } })
  }
  if (assistantError && NOT_AUTHENTICATED_ERRORS.includes(assistantError)) {
    return new ChatFailure({ code: 'NOT_AUTHENTICATED' })
  }
  return agentFailed(result.subtype === 'success' ? result.result : result.errors.join('\n'))
}

function textOf(message: SDKAssistantMessage): string {
  return message.message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
}

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

export function createChatAgent(
  deps: {
    home: string
    claudePath?: string
  } & Partial<Readers>,
): ChatAgent {
  const cwd = join(deps.home, 'chat')
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  const readers = defaultReaders(deps)
  // 答えを閉じてから claude が抜けるまでもメモリを食うので、spawn した child の exit で外す。
  const claudes = new Set<Claude>()
  // SIGKILL した claude について SDK が投げる error は、claude が自分で落ちたときと同じ文なので、止めたことを覚えておく。
  const killed = new WeakSet<Claude>()
  let spare: Spare | undefined

  function kill(claude: Claude | undefined) {
    if (!claude) return
    killed.add(claude)
    claude.kill('SIGKILL')
  }

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
        () => kill(prepared.claude),
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
      kill(claude)
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
    const stop = () => kill(claude)
    signal?.addEventListener('abort', stop)
    if (signal?.aborted) stop()
    let answered = false
    let rateLimit: SDKRateLimitInfo | undefined
    let assistantError: SDKAssistantMessageError | undefined
    // CLI は API の stream が切れると答えを最初からやり直し、stream しない request に替えると答えを assistant 1 つで返す。
    let streamedSinceRetry = false
    try {
      yield snapshot
      // for await を抜けると SDK は claude の終了を最大 2 秒待つので、result を受けたら iterator を閉じずに返す。
      const messages = q[Symbol.asyncIterator]()
      for (;;) {
        let next: IteratorResult<SDKMessage, void>
        try {
          next = await messages.next()
        } catch (error) {
          if (claude && killed.has(claude)) return
          throw agentFailed(await withStderr((error as Error).message, claude))
        }
        if (next.done) {
          if (claude && killed.has(claude)) return
          throw agentFailed(await withStderr('claude exited before it answered', claude))
        }
        const message = next.value
        if (message.type === 'system' && message.subtype === 'init') {
          console.error(
            `[chat] claude ${claude?.pid}: model ${message.model}, ${message.tools.length} tools, ${message.mcp_servers.length} MCP servers`,
          )
        } else if (message.type === 'system' && message.subtype === 'api_retry') {
          streamedSinceRetry = false
          yield { type: 'retry', attempt: message.attempt }
        } else if (
          message.type === 'stream_event' &&
          message.event.type === 'content_block_delta' &&
          message.event.delta.type === 'text_delta'
        ) {
          streamedSinceRetry = true
          yield { type: 'text', text: message.event.delta.text }
        } else if (message.type === 'assistant') {
          assistantError = message.error
          const text = textOf(message)
          if (!message.error && !streamedSinceRetry && text) yield { type: 'text', text }
        } else if (message.type === 'rate_limit_event') {
          rateLimit = message.rate_limit_info
          const { status, utilization, rateLimitType, resetsAt } = rateLimit
          if (status === 'allowed_warning' && utilization !== undefined && rateLimitType) {
            yield {
              type: 'usage',
              utilization,
              rateLimitType,
              ...(resetsAt !== undefined && { resetsAt }),
            }
          }
        } else if (message.type === 'result') {
          // Backend の stdout は Shell 宛ての JSON 行だけなので、prompt cache の観察に使う usage は stderr に出す。
          const { usage } = message
          console.error(
            `[chat] claude ${claude?.pid}: usage input ${usage.input_tokens}, cache creation ${usage.cache_creation_input_tokens ?? 0}, cache read ${usage.cache_read_input_tokens ?? 0}, output ${usage.output_tokens}`,
          )
          // SDK はこの 0.5〜1.4 秒後に error result を投げ直すが、それを待たずに決め、finally で claude を止める。
          if (message.is_error || message.subtype !== 'success') {
            throw failureOf(message, rateLimit, assistantError)
          }
          answered = true
          return
        }
      }
    } finally {
      signal?.removeEventListener('abort', stop)
      // prompt が終わると SDK が stdin を閉じ、答え終えた claude は自分から抜ける。
      end()
      if (answered) {
        prepare()
      } else {
        // abort はたいてい side panel を閉じたときで次の質問は来ないので、spare を起こさない。
        // 失敗を決めた claude も、自分で抜けるのを待つと同時の 4 つに数えたまま残るので止める。
        stop()
      }
    }
  }

  const chatAgent: ChatAgent = {
    stop() {
      if (spare) clearTimeout(spare.timer)
      spare = undefined
      for (const claude of claudes) kill(claude)
    },
  }
  internalsOf.set(chatAgent, {
    prepare,
    async ask({ question, page, history }, signal) {
      // 本文への変換は数百 ms で、spare から答えれば claude を並べて起こす得は小さいので、変換を先に済ませる。
      const snapshot = await snapshotOf(page, history, { readers, signal })
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
