import type { AskInput, ChatEvent, Page, Turn } from '../contract.ts'

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
}

export type ChatSnapshot = { entries: readonly ChatEntry[]; answering: boolean }

/** side panel の Chat。document の memory にだけあり、どこにも残さない（ADR-0030・0031）。 */
export type ChatStore = {
  snapshot: () => ChatSnapshot
  subscribe: (listener: () => void) => () => void
  /** side panel を開いた時に呼ぶ。質問はそれぞれ、送る時に readPage で読んだ Current Page について訊く。 */
  open: (readPage: () => Promise<Page>) => void
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
  let readPage: (() => Promise<Page>) | undefined
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
    read: () => Promise<Page>,
  ) => {
    const live = () => answering === controller
    try {
      const page = await read()
      if (!live()) return
      const events = await client.ask(
        { question, page, history: [...history] },
        { signal: controller.signal },
      )
      let text = ''
      for await (const event of events) {
        if (!live()) return
        text += event.text
        patch(id, { answer: text, status: 'answering' })
      }
      if (!live()) return
      history = [...history, { question, page, answer: text }]
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
