import { ORPCError } from '@orpc/client'

import type { StudyMessage, StudyWatchEvent } from '../contract.ts'
import { writtenArtifact } from './artifact-link.ts'
import { failureLine, type StudyClient } from './client.ts'

const REOPEN_MS = 1000

export type ConversationClient = Pick<StudyClient, 'get' | 'send' | 'watch' | 'permission'>

export type ConversationSnapshot = {
  /** get を読むまでは無い。 */
  study: { dir: string; missionLine: string | null; firstMessage: string | null } | undefined
  missing: boolean
  /** 続いている Study Conversation の行。pending の許可の行は除く。 */
  messages: readonly StudyMessage[]
  /** 入力欄の代わりに出す許可の行。pending の行のうち id の最も小さいもの。 */
  permission: StudyMessage | null
  running: boolean
  partialText: string
  /** turn が失敗した時の 1 行。DB に無いので、次に送るか開き直すと消える。 */
  turnError: string | null
  sendError: string | null
}

export type ConversationStore = ReturnType<typeof createConversationStore>

const isNotFound = (error: unknown) => error instanceof ORPCError && error.code === 'NOT_FOUND'

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

export function createConversationStore(
  client: ConversationClient,
  id: string,
  onTurnEnded?: () => void,
  /** Tutor が Study の dir の file を書き終えた時に、その相対 path で呼ぶ。get で読んだ行では呼ばない。 */
  onArtifactWritten?: (path: string) => void,
) {
  const rows = new Map<number, StudyMessage>()
  let conversationId: string | null = null
  let sending = false
  let snapshot: ConversationSnapshot = {
    study: undefined,
    missing: false,
    messages: [],
    permission: null,
    running: false,
    partialText: '',
    turnError: null,
    sendError: null,
  }
  const listeners = new Set<() => void>()

  function set(next: Partial<ConversationSnapshot>) {
    const current = [...rows.values()]
      .filter((message) => message.conversationId === conversationId)
      .toSorted((a, b) => a.id - b.id)
    const messages = current.filter((message) => message.state !== 'pending')
    const permission = current.find((message) => message.state === 'pending') ?? null
    snapshot = { ...snapshot, messages, permission, ...next }
    for (const listener of listeners) listener()
  }

  function put(message: StudyMessage) {
    rows.set(message.id, message)
    conversationId ??= message.conversationId
  }

  async function load(signal: AbortSignal) {
    const { dir, missionLine, firstMessage, conversations } = await client.get({ id }, { signal })
    const open = conversations.find((conversation) => conversation.endedAt === null)
    for (const conversation of conversations) {
      for (const message of conversation.messages) rows.set(message.id, message)
    }
    conversationId = open?.id ?? conversationId
    set({ study: { dir, missionLine, firstMessage } })
  }

  async function apply(event: StudyWatchEvent, signal: AbortSignal) {
    switch (event.type) {
      case 'snapshot':
        set({ running: event.running, partialText: event.partialText })
        await load(signal)
        return
      case 'turn-started':
        conversationId = event.conversationId
        set({ running: true, partialText: '', turnError: null })
        return
      case 'message': {
        put(event.message)
        const written = snapshot.study && writtenArtifact(event.message, snapshot.study.dir)
        if (written) onArtifactWritten?.(written)
        set(event.message.kind === 'tutor' ? { partialText: '' } : {})
        return
      }
      case 'delta':
        set({ partialText: snapshot.partialText + event.text })
        return
      case 'turn-ended':
        set({ running: false, partialText: '', turnError: event.error })
        await load(signal)
        onTurnEnded?.()
    }
  }

  async function run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const stream = await client.watch({ id }, { signal })
        for await (const event of stream) await apply(event, signal)
      } catch (error) {
        if (signal.aborted) return
        if (isNotFound(error)) return set({ missing: true })
      }
      await wait(REOPEN_MS, signal)
    }
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    /** watch を開き、切れたら開き直す。返す関数で流れを切る（turn は止まらない）。 */
    open(): () => void {
      const controller = new AbortController()
      void run(controller.signal)
      return () => controller.abort()
    },
    async answer(rowId: number, allow: boolean): Promise<void> {
      try {
        put(await client.permission.answer({ id: rowId, allow }))
        set({ sendError: null })
      } catch (error) {
        set({ sendError: failureLine(error) })
      }
    },
    /** 走っている turn の間や送っている途中は送らずに false を返す。 */
    async send(text: string): Promise<boolean> {
      if (snapshot.running || sending) return false
      sending = true
      try {
        const { message } = await client.send({ id, text })
        put(message)
        set({ turnError: null, sendError: null })
        return true
      } catch (error) {
        set({ sendError: failureLine(error) })
        return false
      } finally {
        sending = false
      }
    },
  }
}
