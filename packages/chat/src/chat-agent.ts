import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  type ModelInfo,
  type Options,
  query,
  type Query,
  type SDKUserMessage,
  startup,
  type WarmQuery,
} from '@anthropic-ai/claude-agent-sdk'

import { type Claude, claudeOptions, stderrTail } from './claude.ts'
import {
  type AskInput,
  type ChatEvent,
  type Choice,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  type Model,
  type SnapshotEvent,
} from './contract.ts'
import { agentFailed } from './failure.ts'
import { askContent } from './page/prompt.ts'
import { defaultReaders, type Readers, snapshotOf } from './page/snapshot.ts'
import { promptless, singleTurn, userMessage } from './prompt.ts'
import { EndedEarly, translate } from './translate.ts'

// 1 つ 270〜290MB の claude を token の無い口から起こせるので、spare も含めてこの数で止める（ADR-0031）。
const MAX_CLAUDES = 4
const SPARE_LIFETIME_MS = 5 * 60_000

async function withStderr(message: string, claude: Claude | undefined): Promise<string> {
  const stderr = claude ? (await stderrTail(claude)).trim() : ''
  return stderr ? `${message}\n${stderr}` : message
}

export type ChatAgent = {
  /** 持っている claude すべてに SIGKILL を送る。Backend の exit() は await を挟まずに抜けるので同期にする。 */
  stop(): void
}

type Internals = {
  /** spare の initialize を待たずに返る。 */
  prepare(choice: Choice | undefined): void
  /** 最初に読めた一覧を持ち、2 回目からは claude を起こさない。空きが無ければ undefined を返す。 */
  models(): Promise<Model[] | undefined>
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
type Spare = Started<Promise<WarmQuery>> & {
  choice: Required<Choice>
  timer: ReturnType<typeof setTimeout>
  ready: boolean
}

const resolved = ({ model, effort }: Choice = {}): Required<Choice> => ({
  model: model ?? DEFAULT_MODEL,
  effort: effort ?? DEFAULT_EFFORT,
})

const sameChoice = (a: Required<Choice>, b: Required<Choice>) =>
  a.model === b.model && a.effort === b.effort

function modelOf({
  value,
  displayName,
  description,
  supportsEffort,
  supportedEffortLevels,
}: ModelInfo): Model {
  return {
    value,
    displayName,
    description,
    ...(supportsEffort !== undefined && { supportsEffort }),
    ...(supportedEffortLevels && { supportedEffortLevels }),
  }
}

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
  let reading = 0
  // SIGKILL した claude について SDK が投げる error は、claude が自分で落ちたときと同じ文なので、止めたことを覚えておく。
  const killed = new WeakSet<Claude>()
  let spare: Spare | undefined
  let models: Model[] | undefined
  let readingModels: Promise<Model[]> | undefined

  function kill(claude: Claude | undefined) {
    if (!claude) return
    killed.add(claude)
    claude.kill('SIGKILL')
  }

  // SDK は query() と startup() の呼び出しの中で同期に spawn するので、空きを確かめてから呼ぶまでに await を挟まない。
  function spawnWith<T>(choice: Required<Choice>, start: (options: Options) => T): Started<T> {
    let claude: Claude | undefined
    const started = start(
      claudeOptions({
        cwd,
        claudePath: deps.claudePath,
        choice,
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

  // 起動中の spare は close() しても initialize を待ってから閉じるので、すぐに止める。
  function discard(dropped: Spare) {
    if (spare === dropped) spare = undefined
    clearTimeout(dropped.timer)
    if (!dropped.ready) {
      kill(dropped.claude)
      return
    }
    void dropped.started.then((warm) => warm.close())
  }

  function prepare(choice: Required<Choice>) {
    if (spare && sameChoice(spare.choice, choice)) return
    if (spare) discard(spare)
    if (claudes.size >= MAX_CLAUDES) return
    const started = spawnWith(choice, (options) => startup({ options }))
    const timer = setTimeout(() => {
      if (spare !== prepared) return
      spare = undefined
      void prepared.started.then(
        (warm) => warm.close(),
        () => kill(prepared.claude),
      )
    }, SPARE_LIFETIME_MS)
    const prepared: Spare = { ...started, choice, timer, ready: false }
    // 失敗は ask が spare を使うときに受ける。
    started.started.then(
      () => (prepared.ready = true),
      () => {},
    )
    spare = prepared
  }

  function readModels(): Promise<Model[]> {
    const { promise: ended, resolve: end } = Promise.withResolvers<void>()
    const { started: q, claude } = spawnWith(resolved(), (options) =>
      query({ prompt: promptless(ended), options }),
    )
    return q
      .supportedModels()
      .then((found) => found.map(modelOf))
      .catch(async (error: unknown) => {
        throw new Error(await withStderr((error as Error).message, claude))
      })
      .finally(() => {
        end()
        q.close()
      })
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
    return spawnWith(claimed.choice, (options) => query({ prompt, options }))
  }

  async function* answer(
    { started: q, claude }: Started<Query>,
    choice: Required<Choice>,
    end: () => void,
    signal: AbortSignal | undefined,
    snapshot: SnapshotEvent,
  ): AsyncGenerator<ChatEvent> {
    // generator の finally は走っている await が終わるまで走らないので、abort ではすぐに送る。
    const stop = () => kill(claude)
    signal?.addEventListener('abort', stop)
    if (signal?.aborted) stop()
    let answered = false
    try {
      yield snapshot
      try {
        // Backend の stdout は Shell 宛ての JSON 行だけなので、prompt cache の観察に使う usage も stderr に出す。
        yield* translate(q[Symbol.asyncIterator](), (line) =>
          console.error(`[chat] claude ${claude?.pid}: ${line}`),
        )
      } catch (error) {
        if (!(error instanceof EndedEarly)) throw error
        if (claude && killed.has(claude)) return
        throw agentFailed(await withStderr(error.message, claude))
      }
      answered = true
    } finally {
      signal?.removeEventListener('abort', stop)
      // prompt が終わると SDK が stdin を閉じ、答え終えた claude は自分から抜ける。
      end()
      if (answered) {
        prepare(choice)
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
    prepare: (choice) => prepare(resolved(choice)),
    async models() {
      if (models) return models
      if (!readingModels) {
        if (claudes.size >= MAX_CLAUDES) return undefined
        readingModels = readModels().finally(() => (readingModels = undefined))
      }
      models = await readingModels
      return models
    },
    async ask({ question, page, history, ...asked }, signal) {
      const choice = resolved(asked)
      // 変換の Worker は最長 30 秒 CPU と memory を使うので、claude と同じく同時の数を抑える。
      if (reading >= MAX_CLAUDES) return undefined
      reading++
      // 本文への変換は数百 ms で、spare から答えれば claude を並べて起こす得は小さいので、変換を先に済ませる。
      const snapshot = await snapshotOf(page, history, { readers, signal }).finally(() => reading--)
      const { content, omitted } = askContent(question, snapshot, history)
      // contract の snapshot の page は screenshot を持たないので、oRPC の output の検証が落とす。
      const event: SnapshotEvent = { type: 'snapshot', page: snapshot, omitted }
      const { prompt, end } = singleTurn(userMessage(content))
      const claimed = spare
      if (claimed && sameChoice(claimed.choice, choice)) {
        spare = undefined
        clearTimeout(claimed.timer)
        return answer(await fromSpare(claimed, prompt), choice, end, signal, event)
      }
      if (claimed) discard(claimed)
      if (claudes.size >= MAX_CLAUDES) return undefined
      return answer(
        spawnWith(choice, (options) => query({ prompt, options })),
        choice,
        end,
        signal,
        event,
      )
    },
  })
  return chatAgent
}
