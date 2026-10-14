import { ORPCError } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'

import {
  type AskInput,
  type Choice,
  ChoiceSchema,
  type contract,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  type Effort,
  MAX_ASK_BODY_BYTES,
  type Model,
  type Page,
  type PageSnapshot,
  type Turn,
  type Unreadable,
} from '../contract.ts'
import { addressOf, type CurrentPage } from './current-page.ts'
import { type Failure, failureOf, retryingLine, usageLine } from './failure.ts'
import { isUnreachable } from './native-host.ts'
import { noticeOf } from './notice.ts'
import { type Reach, watchReach } from './reach.ts'

export type ChatClient = ContractRouterClient<typeof contract>

export type ChatEntry = {
  id: number
  question: string
  answer: string
  status: 'waiting' | 'answering' | 'answered' | 'failed' | 'stopped'
  /** 読めなかった・切り詰めた・渡していないことを、質問の吹き出しの下に出す 1 行。 */
  notice?: string
  /** 質問に添えたスクリーンショットの JPEG の base64。吹き出しに縮小を出す。 */
  screenshot?: string
  /** API の再試行を待つ間、答えの代わりに出す 1 行。 */
  retrying?: string
  /** claude が Web を検索している間、答えの下に淡く出す 1 行。 */
  searching?: string
  /** 答えの場所に出す失敗。 */
  failure?: Failure
  /** plan の使用量の警告。答えの下に淡く出す。 */
  usage?: string
}

// 答えの代わりや下に出す一時の 1 行は、答えが進むか終わったら消す。
const NO_PASSING_LINES = { retrying: undefined, searching: undefined }

// oRPC が input を包む分の余白。
const BODY_MARGIN_BYTES = 1024 * 1024

// File は JSON.stringify で {} になり、multipart の別の part で送られる。
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

// Backend は質問と答えの文字をそのまま prompt にするので、印も文字のまま claude に渡る。
const STOPPED_MARK = '（ユーザーが途中で止めた）'
const LEFT_OUT_MARK = '（大きすぎて送れなかった）'

const TOO_LARGE: Unreadable = { kind: 'unreadable', reason: 'too-large' }

const bodyBytes = (input: AskInput) =>
  jsonBytes(input) + (input.page.content.kind === 'pdf' ? input.page.content.pdf.size : 0)

/** 前のページから本文・選択範囲・スクリーンショットを外し、本文は大きすぎて渡せなかったことにする。外すものが無ければ undefined。 */
function withoutBody(page: PageSnapshot): PageSnapshot | undefined {
  const { selection, screenshot, ...rest } = page
  const text = page.content?.kind === 'text' && page.content.text !== ''
  if (!text && selection === undefined && screenshot === undefined) return undefined
  return text ? { ...rest, content: TOO_LARGE } : rest
}

/**
 * Current Page の PDF に残る bytes。body の上限から、前のページを外した PDF の他の input と余白を引く。
 * Current Page のスクリーンショットは読むのと並べて撮るので数えず、送る前の withinBodyLimit が数える。
 */
function pdfBudget(question: string, history: readonly Turn[]): number {
  const bare = history.map((turn) => ({ ...turn, page: withoutBody(turn.page) ?? turn.page }))
  return MAX_ASK_BODY_BYTES - BODY_MARGIN_BYTES - jsonBytes({ question, history: bare })
}

const withoutPage = (turn: Turn): Turn | undefined => {
  const page = withoutBody(turn.page)
  return page && { ...turn, page }
}

const withoutWords = (turn: Turn): Turn => ({
  ...turn,
  question: LEFT_OUT_MARK,
  answer: LEFT_OUT_MARK,
})

/**
 * 上限に収まるまで古い turn から shrink し、収まった input を返す。全部 shrink しても超えれば undefined。
 * turn は落とさない。same が turn の番号で前のページを指すため。
 */
function leaveOutEarlier(
  input: AskInput,
  shrink: (turn: Turn) => Turn | undefined,
): AskInput | undefined {
  let over = bodyBytes(input) + BODY_MARGIN_BYTES - MAX_ASK_BODY_BYTES
  const history = input.history.map((turn) => {
    const shrunk = over > 0 ? shrink(turn) : undefined
    if (!shrunk) return turn
    const saved = jsonBytes(turn) - jsonBytes(shrunk)
    if (saved <= 0) return turn
    over -= saved
    return shrunk
  })
  return over <= 0 ? { ...input, history } : undefined
}

/**
 * body の上限を超える input は、Backend が字数の上限で落とすのと同じく、古い turn のページから外していく。
 * 前のページを全部外しても超えるなら、Current Page の HTML・PDF・選択範囲を外し、大きすぎて読めなかったことにする。
 * それでも超えるなら、古い turn の質問と答えを印に置き換える。
 * ユーザーが添えると決めた Current Page のスクリーンショットは残す。
 */
function withinBodyLimit(input: AskInput): AskInput {
  if (bodyBytes(input) + BODY_MARGIN_BYTES <= MAX_ASK_BODY_BYTES) return input
  const { url, title, screenshot, screenshotFailed } = input.page
  const page: Page = {
    ...addressOf({ url, title }),
    content: TOO_LARGE,
    ...(screenshot !== undefined && { screenshot }),
    ...(screenshotFailed && { screenshotFailed }),
  }
  const bare = { ...input, page, history: input.history.map((turn) => withoutPage(turn) ?? turn) }
  return (
    leaveOutEarlier(input, withoutPage) ??
    leaveOutEarlier({ ...input, page }, withoutPage) ??
    leaveOutEarlier(bare, withoutWords) ??
    bare
  )
}

/** 入力欄の左に出す model と effort の選択。一覧が届くまでは無い。 */
export type Picker = {
  models: readonly Model[]
  model: string
  /** 選んだ model が effort を持たなければ undefined。 */
  effort: Effort | undefined
  efforts: readonly Effort[]
}

export type ChatSnapshot = {
  entries: readonly ChatEntry[]
  picker: Picker | undefined
  answering: boolean
  /** スクリーンショットのボタンが押されていて、次に送る質問に添える。 */
  withScreenshot: boolean
  /** Backend に届かない。入力欄の上に帯を出す。 */
  unreachable: boolean
  /** 再試行のボタンを付ける entry の id。最後の質問が失敗したときだけある。 */
  retryable: number | undefined
}

export type ReadOptions = { screenshot: boolean; maxPdfBytes: number; signal: AbortSignal }

/** shown は送った時に side panel が出していた Current Page で、読み終える前に止めた質問の履歴に入れる。 */
export type Reading = { shown: CurrentPage; page: Promise<Page> }

/**
 * 送る時に Current Page を読む。screenshot なら、その Browser Tab の表示領域も撮る。
 * PDF は maxPdfBytes を超えたら読むのをやめる。signal が abort したら、PDF の fetch もやめる。
 */
export type ReadPage = (options: ReadOptions) => Reading

/** side panel の Chat。document の memory にだけあり、どこにも残さない（ADR-0030・0031）。 */
export type ChatStore = {
  snapshot: () => ChatSnapshot
  subscribe: (listener: () => void) => () => void
  /**
   * side panel を開いた時に呼ぶ。質問はそれぞれ、送る時に readPage で読んだ Current Page について訊く。
   * Backend に届かない間は、focus が focus の event を出すたびにも確かめ直す。返す関数で確かめ直しを止める。
   */
  open: (readPage: ReadPage, focus: EventTarget) => () => void
  /** 開く前と答えている間は送らずに false を返す。送ったらスクリーンショットのボタンを外す。 */
  ask: (question: string) => boolean
  /** 最後の質問が失敗していれば、送った input のまま送り直す。ページを読み直さず、スクリーンショットも撮り直さない。 */
  retry: () => boolean
  /** 答えの stream を abort し、途中までの答えを止めた印を付けて履歴に入れる。 */
  stop: () => void
  toggleScreenshot: () => void
  /** 選んだものを残し、次の prepare と ask から付ける。 */
  chooseModel: (model: string) => void
  chooseEffort: (effort: Effort) => void
  /** 今の Chat を終える。答えの途中なら、その stream を abort する。 */
  startNewChat: () => void
}

/** 送った質問。答えが返るか履歴から外れるまで、送った input（HTML・PDF・スクリーンショットも）を持つ。 */
type Sent = { id: number; question: string; input: Promise<AskInput>; shown: CurrentPage }

type Asking = Sent & {
  controller: AbortController
  answer: string
  retried: boolean
  /** chat.ask の応答が届いた。 */
  reached: boolean
  /** 履歴に入れるページ。snapshot が届くまでは送ったページの URL と title とスクリーンショットだけ。 */
  page: PageSnapshot
}

export type ChoiceStorage = Pick<Storage, 'getItem' | 'setItem'>

const CHOICE_KEY = 'monica-chat-choice'

// 読めない値と、private な窓などで storage が投げるときは、何も選んでいないことにする。
function readChoice(storage: ChoiceStorage): Choice {
  try {
    const parsed = ChoiceSchema.safeParse(JSON.parse(storage.getItem(CHOICE_KEY) ?? '{}'))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

function writeChoice(storage: ChoiceStorage, choice: Choice) {
  try {
    storage.setItem(CHOICE_KEY, JSON.stringify(choice))
  } catch {}
}

const modelIn = (models: readonly Model[], model: string) =>
  models.find(({ value }) => value === model)

// managed settings が haiku を一覧から外したときは、Backend の既定に任せず一覧の先頭を付ける。
const defaultModelIn = (models: readonly Model[]) =>
  modelIn(models, DEFAULT_MODEL) ? undefined : models[0]?.value

type Listing =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; models: readonly Model[] }

export function createChatStore(client: ChatClient, storage: ChoiceStorage): ChatStore {
  let saved = readChoice(storage)
  let listing: Listing = { state: 'loading' }
  let entries: readonly ChatEntry[] = []
  let history: readonly Turn[] = []
  let asking: Asking | undefined
  let failed: Sent | undefined
  let reach: Reach | undefined
  let withScreenshot = false
  let snapshot: ChatSnapshot = {
    entries,
    picker: undefined,
    answering: false,
    withScreenshot,
    unreachable: false,
    retryable: undefined,
  }
  let readPage: ReadPage | undefined
  let nextId = 0
  const listeners = new Set<() => void>()

  // 一覧を読む間も残した組を付けるのは、spare をその組で起こさせるため。
  function chosen(): Choice {
    if (listing.state === 'loading') return saved
    if (listing.state === 'failed') return {}
    const model = saved.model ?? defaultModelIn(listing.models)
    const entry = modelIn(listing.models, model ?? DEFAULT_MODEL)
    const { effort } = saved
    const offered = effort && entry?.supportsEffort && entry.supportedEffortLevels?.includes(effort)
    return { ...(model && { model }), ...(offered && { effort }) }
  }

  function picker(): Picker | undefined {
    if (listing.state !== 'ready' || listing.models.length === 0) return undefined
    const { models } = listing
    const { model = DEFAULT_MODEL, effort = DEFAULT_EFFORT } = chosen()
    const entry = modelIn(models, model)
    const efforts = (entry?.supportsEffort && entry.supportedEffortLevels) || []
    return { models, model, effort: efforts.length > 0 ? effort : undefined, efforts }
  }

  const publish = (next: readonly ChatEntry[] = entries) => {
    entries = next
    snapshot = {
      entries,
      picker: picker(),
      answering: asking !== undefined,
      withScreenshot,
      unreachable: reach?.unreachable() ?? false,
      retryable: failed?.id,
    }
    for (const listener of listeners) listener()
  }
  const patch = (id: number, change: Partial<ChatEntry>) =>
    publish(entries.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)))

  // 止めた後と新しい Chat が始まった後に届いたものは描かない。
  const answer = async (current: Asking) => {
    const live = () => asking === current
    const { id, question } = current
    try {
      const input = await current.input
      if (!live()) return
      // Backend はスクリーンショットを送り返さないので、送ったものを履歴に足して次の質問から送り直す。
      const { screenshot } = input.page
      const sent = screenshot === undefined ? {} : { screenshot }
      if (screenshot !== undefined) patch(id, sent)
      current.page = { ...addressOf(input.page), ...sent }
      const events = await client.ask(input, { signal: current.controller.signal })
      current.reached = true
      reach?.reached()
      for await (const event of events) {
        if (!live()) return
        // Backend は Chat を持たないので、本文にした Page Snapshot を返してもらい、次の質問から送り直す（ADR-0031）。
        if (event.type === 'snapshot') {
          current.page = { ...event.page, ...sent }
          const notice = noticeOf(event)
          if (notice) patch(id, { notice })
        } else if (event.type === 'text') {
          current.answer += event.text
          patch(id, { ...NO_PASSING_LINES, answer: current.answer, status: 'answering' })
        } else if (event.type === 'retry') {
          // CLI は答えを最初からやり直すので、途中までの答えを消す。
          current.answer = ''
          current.retried = true
          patch(id, {
            ...NO_PASSING_LINES,
            answer: '',
            status: 'answering',
            retrying: retryingLine(event.attempt),
          })
        } else if (event.type === 'search') {
          patch(id, {
            ...NO_PASSING_LINES,
            status: 'answering',
            searching: `検索中: ${event.query}`,
          })
        } else {
          patch(id, { usage: usageLine(event, new Date()) })
        }
      }
      if (!live()) return
      history = [...history, { question, page: current.page, answer: current.answer }]
      asking = undefined
      patch(id, { ...NO_PASSING_LINES, status: 'answered' })
    } catch (error) {
      if (!live()) return
      if (isUnreachable(error)) reach?.failed()
      else if (error instanceof ORPCError) reach?.reached()
      asking = undefined
      failed = { id, question, input: current.input, shown: current.shown }
      patch(id, {
        ...NO_PASSING_LINES,
        status: 'failed',
        failure: failureOf(error, current, new Date()),
      })
    }
  }

  const loadModels = () => {
    listing = { state: 'loading' }
    client.models().then(
      (models) => {
        listing = { state: 'ready', models }
        // 一覧に無い model は選んでいないことにし、次に選んだ effort が既定の model に付くようにする。
        if (saved.model && !modelIn(models, saved.model)) saved = {}
        publish()
      },
      () => {
        listing = { state: 'failed' }
        publish()
      },
    )
  }

  const choose = (choice: Choice) => {
    saved = choice
    writeChoice(storage, saved)
    publish()
  }

  const start = (sent: Sent, controller = new AbortController()) => {
    const current: Asking = {
      ...sent,
      controller,
      answer: '',
      retried: false,
      reached: false,
      page: addressOf(sent.shown),
    }
    asking = current
    void answer(current)
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open(read, focus) {
      readPage = read
      // 一覧は claude が埋まっている間や一時的な失敗でも読めないので、Backend に届いていても focus で読み直す。
      const retryModels = () => listing.state === 'failed' && loadModels()
      focus.addEventListener('focus', retryModels)
      const watching = watchReach(
        () => client.prepare(chosen()),
        focus,
        () => {
          // desktop が起きる前に開いた side panel にも、届いた時に一覧を出す。
          if (!watching.unreachable() && listing.state === 'failed') loadModels()
          publish()
        },
      )
      reach = watching
      // spare の claude を起こさせ、最初の質問の答えを早める（ADR-0031）。届かなければ帯を出す。
      watching.check()
      loadModels()
      return () => {
        focus.removeEventListener('focus', retryModels)
        watching.dispose()
        if (reach === watching) reach = undefined
      }
    },
    ask(question) {
      if (asking || !readPage) return false
      // 再試行せずに次を送ったら、失敗した質問とその input は捨てる。画面には残す。
      failed = undefined
      const id = nextId++
      const turns = [...history]
      const choice = chosen()
      const controller = new AbortController()
      // captureVisibleTab は送る操作の user gesture の中で呼ばないと quota にかかるので、await を挟まずに読み始める。
      const { shown, page } = readPage({
        screenshot: withScreenshot,
        maxPdfBytes: pdfBudget(question, turns),
        signal: controller.signal,
      })
      const input = page.then((read) =>
        withinBodyLimit({ question, page: read, history: turns, ...choice }),
      )
      withScreenshot = false
      start({ id, question, input, shown }, controller)
      publish([...entries, { id, question, answer: '', status: 'waiting' }])
      return true
    },
    retry() {
      if (asking || !failed) return false
      const sent = failed
      failed = undefined
      start(sent)
      patch(sent.id, {
        answer: '',
        ...NO_PASSING_LINES,
        status: 'waiting',
        failure: undefined,
        usage: undefined,
      })
      return true
    },
    stop() {
      if (!asking) return
      const { id, question, controller, answer: text, page } = asking
      controller.abort()
      asking = undefined
      history = [
        ...history,
        { question, page, answer: text ? `${text}\n\n${STOPPED_MARK}` : STOPPED_MARK },
      ]
      patch(id, { ...NO_PASSING_LINES, status: 'stopped' })
    },
    toggleScreenshot() {
      withScreenshot = !withScreenshot
      publish()
    },
    chooseModel: (model) => choose({ ...saved, model }),
    chooseEffort: (effort) => choose({ ...saved, effort }),
    startNewChat() {
      asking?.controller.abort()
      asking = undefined
      failed = undefined
      history = []
      withScreenshot = false
      publish([])
    },
  }
}
