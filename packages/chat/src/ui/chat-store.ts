import { ORPCError } from '@orpc/client'

import {
  type AskInput,
  type ChatEvent,
  MAX_ASK_BODY_BYTES,
  type Page,
  type PageSnapshot,
  type Turn,
} from '../contract.ts'
import { type Failure, failureOf, isUnreachable, retryingLine, usageLine } from './failure.ts'
import { noticeOf } from './notice.ts'
import { type Reach, watchReach } from './reach.ts'

/** side panel が呼ぶ分の chat の client。ブラウザの口への oRPC の client の chat がそのまま入る。 */
export type ChatClient = {
  prepare(): Promise<unknown>
  ask(input: AskInput, options: { signal: AbortSignal }): Promise<AsyncIterable<ChatEvent>>
}

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
  /** 答えの場所に出す失敗。 */
  failure?: Failure
  /** plan の使用量の警告。答えの下に淡く出す。 */
  usage?: string
}

// oRPC が input を包む分の余白。
const BODY_MARGIN_BYTES = 1024 * 1024

// File は JSON.stringify で {} になり、multipart の別の part で送られる。
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

// Backend は答えの文字をそのまま prompt にするので、印も文字のまま claude に渡る。
const STOPPED_MARK = '（ユーザーが途中で止めた）'

/**
 * 今のページの PDF に残る bytes。body の上限から、PDF の他の input と余白を引く。
 * 今のページのスクリーンショットは読むのと並べて撮るので数えず、送る前の withinBodyLimit が数える。
 */
function pdfBudget(question: string, history: readonly Turn[]): number {
  return MAX_ASK_BODY_BYTES - BODY_MARGIN_BYTES - jsonBytes({ question, history })
}

/**
 * body の上限を超える input は、今のページの HTML・PDF・選択範囲を外し、大きすぎて読めなかったことにする。履歴は削らない。
 * ユーザーが添えると決めたスクリーンショットは残す。
 */
function withinBodyLimit(input: AskInput): AskInput {
  const { content } = input.page
  const bytes = jsonBytes(input) + (content.kind === 'pdf' ? content.pdf.size : 0)
  if (bytes + BODY_MARGIN_BYTES <= MAX_ASK_BODY_BYTES) return input
  const { url, title, screenshot, screenshotFailed } = input.page
  return {
    ...input,
    page: {
      ...addressOf({ url, title }),
      content: { kind: 'unreadable', reason: 'too-large' },
      ...(screenshot !== undefined && { screenshot }),
      ...(screenshotFailed && { screenshotFailed }),
    },
  }
}

function addressOf({ url, title }: Pick<PageSnapshot, 'url' | 'title'>) {
  return { ...(url !== undefined && { url }), ...(title !== undefined && { title }) }
}

export type ChatSnapshot = {
  entries: readonly ChatEntry[]
  answering: boolean
  /** スクリーンショットのボタンが押されていて、次に送る質問に添える。 */
  withScreenshot: boolean
  /** Backend に届かない。入力欄の上に帯を出す。 */
  unreachable: boolean
  /** 再試行のボタンを付ける entry の id。最後の質問が失敗したときだけある。 */
  retryable: number | undefined
}

/** 送る時に Current Page を読む。screenshot なら、その Browser Tab の表示領域も撮る。PDF は maxPdfBytes を超えたら読むのをやめる。 */
export type ReadPage = (options: { screenshot: boolean; maxPdfBytes: number }) => Promise<Page>

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
  /** 今の Chat を終える。答えの途中なら、その stream を abort する。 */
  startNewChat: () => void
}

/** 送った質問。答えが返るか履歴から外れるまで、送った input（HTML・PDF・スクリーンショットも）を持つ。 */
type Sent = { id: number; question: string; input: Promise<AskInput> }

type Asking = Sent & {
  controller: AbortController
  answer: string
  retried: boolean
  /** 履歴に入れるページ。snapshot が届くまでは送ったページの URL と title とスクリーンショットだけ。 */
  page: PageSnapshot | undefined
}

export function createChatStore(client: ChatClient): ChatStore {
  let entries: readonly ChatEntry[] = []
  let history: readonly Turn[] = []
  let asking: Asking | undefined
  let failed: Sent | undefined
  let reach: Reach | undefined
  let withScreenshot = false
  let snapshot: ChatSnapshot = {
    entries,
    answering: false,
    withScreenshot,
    unreachable: false,
    retryable: undefined,
  }
  let readPage: ReadPage | undefined
  let nextId = 0
  const listeners = new Set<() => void>()

  const publish = (next: readonly ChatEntry[] = entries) => {
    entries = next
    snapshot = {
      entries,
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
          patch(id, { answer: current.answer, status: 'answering', retrying: undefined })
        } else if (event.type === 'retry') {
          // CLI は答えを最初からやり直すので、途中までの答えを消す。
          current.answer = ''
          current.retried = true
          patch(id, { answer: '', status: 'answering', retrying: retryingLine(event.attempt) })
        } else {
          patch(id, { usage: usageLine(event, new Date()) })
        }
      }
      if (!live()) return
      history = [...history, { question, page: current.page, answer: current.answer }]
      asking = undefined
      patch(id, { status: 'answered' })
    } catch (error) {
      if (!live()) return
      if (isUnreachable(error)) reach?.failed()
      else if (error instanceof ORPCError) reach?.reached()
      asking = undefined
      failed = { id, question, input: current.input }
      patch(id, {
        status: 'failed',
        retrying: undefined,
        failure: failureOf(error, current, new Date()),
      })
    }
  }

  const start = (sent: Sent) => {
    const current: Asking = {
      ...sent,
      controller: new AbortController(),
      answer: '',
      retried: false,
      page: undefined,
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
      const watching = watchReach(
        () => client.prepare(),
        focus,
        () => publish(),
      )
      reach = watching
      // spare の claude を起こさせ、最初の質問の答えを早める（ADR-0031）。届かなければ帯を出す。
      watching.check()
      return () => {
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
      // captureVisibleTab は送る操作の user gesture の中で呼ばないと quota にかかるので、await を挟まずに読み始める。
      const input = readPage({
        screenshot: withScreenshot,
        maxPdfBytes: pdfBudget(question, turns),
      }).then((page) => withinBodyLimit({ question, page, history: turns }))
      withScreenshot = false
      start({ id, question, input })
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
        status: 'waiting',
        retrying: undefined,
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
        { question, page: page ?? {}, answer: text ? `${text}\n\n${STOPPED_MARK}` : STOPPED_MARK },
      ]
      patch(id, { status: 'stopped', retrying: undefined })
    },
    toggleScreenshot() {
      withScreenshot = !withScreenshot
      publish()
    },
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
