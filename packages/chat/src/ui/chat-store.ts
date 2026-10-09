import {
  type AskInput,
  type ChatEvent,
  MAX_ASK_BODY_BYTES,
  type Page,
  type PageSnapshot,
  type Turn,
} from '../contract.ts'
import { noticeOf } from './notice.ts'

/** side panel が呼ぶ分の chat の client。ブラウザの口への oRPC の client の chat がそのまま入る。 */
export type ChatClient = {
  prepare(): Promise<unknown>
  ask(input: AskInput, options: { signal: AbortSignal }): Promise<AsyncIterable<ChatEvent>>
}

export type ChatEntry = {
  id: number
  question: string
  answer: string
  status: 'waiting' | 'answering' | 'answered' | 'failed'
  /** 読めなかった・切り詰めた・渡していないことを、質問の吹き出しの下に出す 1 行。 */
  notice?: string
}

// oRPC が input を包む分の余白。
const BODY_MARGIN_BYTES = 1024 * 1024

// File は JSON.stringify で {} になり、multipart の別の part で送られる。
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** 今のページの PDF に残る bytes。body の上限から、PDF の他の input と余白を引く。 */
function pdfBudget(question: string, history: readonly Turn[]): number {
  return MAX_ASK_BODY_BYTES - BODY_MARGIN_BYTES - jsonBytes({ question, history })
}

/** body の上限を超える input は、今のページの HTML・PDF・選択範囲を外し、大きすぎて読めなかったことにする。履歴は削らない。 */
function withinBodyLimit(input: AskInput): AskInput {
  const { content } = input.page
  const bytes = jsonBytes(input) + (content.kind === 'pdf' ? content.pdf.size : 0)
  if (bytes + BODY_MARGIN_BYTES <= MAX_ASK_BODY_BYTES) return input
  return {
    ...input,
    page: { ...addressOf(input.page), content: { kind: 'unreadable', reason: 'too-large' } },
  }
}

function addressOf({ url, title }: Pick<PageSnapshot, 'url' | 'title'>) {
  return { ...(url !== undefined && { url }), ...(title !== undefined && { title }) }
}

export type ChatSnapshot = { entries: readonly ChatEntry[]; answering: boolean }

/** side panel の Chat。document の memory にだけあり、どこにも残さない（ADR-0030・0031）。 */
export type ChatStore = {
  snapshot: () => ChatSnapshot
  subscribe: (listener: () => void) => () => void
  /**
   * side panel を開いた時に呼ぶ。質問はそれぞれ、送る時に readPage で読んだ Current Page について訊く。
   * readPage は、PDF が maxPdfBytes を超えたら読むのをやめる。
   */
  open: (readPage: (maxPdfBytes: number) => Promise<Page>) => void
  /** 開く前と答えている間は送らずに false を返す。 */
  ask: (question: string) => boolean
  /** 今の Chat を終える。答えの途中なら、その stream を abort する。 */
  startNewChat: () => void
}

export function createChatStore(client: ChatClient): ChatStore {
  let entries: readonly ChatEntry[] = []
  let history: readonly Turn[] = []
  let answering: AbortController | undefined
  let snapshot: ChatSnapshot = { entries, answering: false }
  let readPage: ((maxPdfBytes: number) => Promise<Page>) | undefined
  let nextId = 0
  const listeners = new Set<() => void>()

  const publish = (next: readonly ChatEntry[]) => {
    entries = next
    snapshot = { entries, answering: answering !== undefined }
    for (const listener of listeners) listener()
  }
  const patch = (id: number, change: Partial<ChatEntry>) =>
    publish(entries.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)))

  // 新しい Chat が始まった後に届いたものは、前の Chat の答えなので捨てる。
  const answer = async (
    id: number,
    question: string,
    controller: AbortController,
    read: (maxPdfBytes: number) => Promise<Page>,
  ) => {
    const live = () => answering === controller
    try {
      const page = await read(pdfBudget(question, history))
      if (!live()) return
      const events = await client.ask(withinBodyLimit({ question, page, history: [...history] }), {
        signal: controller.signal,
      })
      let text = ''
      // Backend は Chat を持たないので、本文にした Page Snapshot を返してもらい、次の質問から送り直す（ADR-0031）。
      let turnPage: PageSnapshot = addressOf(page)
      for await (const event of events) {
        if (!live()) return
        if (event.type === 'snapshot') {
          turnPage = event.page
          const notice = noticeOf(event)
          if (notice) patch(id, { notice })
          continue
        }
        text += event.text
        patch(id, { answer: text, status: 'answering' })
      }
      if (!live()) return
      history = [...history, { question, page: turnPage, answer: text }]
      answering = undefined
      patch(id, { status: 'answered' })
    } catch {
      if (!live()) return
      answering = undefined
      patch(id, { status: 'failed' })
    }
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open(read) {
      readPage = read
      // spare の claude を起こさせ、最初の質問の答えを早める（ADR-0031）。Backend の不在は質問の失敗で知らせる。
      client.prepare().catch(() => {})
    },
    ask(question) {
      if (answering || !readPage) return false
      const controller = new AbortController()
      answering = controller
      const id = nextId++
      publish([...entries, { id, question, answer: '', status: 'waiting' }])
      void answer(id, question, controller, readPage)
      return true
    },
    startNewChat() {
      answering?.abort()
      answering = undefined
      history = []
      publish([])
    },
  }
}
