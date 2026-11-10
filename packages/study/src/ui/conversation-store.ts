import { ORPCError } from '@orpc/client'

import type { StudyMessage, StudyWatchEvent } from '../contract.ts'
import { writtenArtifact } from './artifact-link.ts'
import { failureLine, type StudyClient } from './client.ts'

const REOPEN_MS = 1000

export type ConversationClient = Pick<
  StudyClient,
  'get' | 'send' | 'watch' | 'permission' | 'conversation'
>

export type ConversationSummary = {
  id: string
  startedAt: Date
  endedAt: Date | null
  summary: string | null
}

export type ConversationSnapshot = {
  study: { dir: string; missionLine: string | null; firstMessage: string | null } | undefined
  missing: boolean
  conversations: readonly ConversationSummary[]
  /** null は空の新しい会話。 */
  shown: ConversationSummary | null
  ongoingId: string | null
  repos: readonly string[]
  messages: readonly StudyMessage[]
  permission: StudyMessage | null
  running: boolean
  partialText: string
  /** DB に無いので、次に送るか開き直すと消える。 */
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
  /** get で読んだ行では呼ばない。 */
  onArtifactWritten?: (path: string) => void,
) {
  const rows = new Map<number, StudyMessage>()
  /** null は空の新しい会話。 */
  let conversationId: string | null = null
  /** null なら conversationId を出す。 */
  let selected: string | null = null
  let loaded = false
  let sending = false
  let snapshot: ConversationSnapshot = {
    study: undefined,
    missing: false,
    conversations: [],
    shown: null,
    ongoingId: null,
    repos: [],
    messages: [],
    permission: null,
    running: false,
    partialText: '',
    turnError: null,
    sendError: null,
  }
  const listeners = new Set<() => void>()

  function set(next: Partial<ConversationSnapshot>) {
    const shownId = selected ?? conversationId
    const conversations = next.conversations ?? snapshot.conversations
    const shown =
      conversations.find((conversation) => conversation.id === shownId) ??
      (shownId === null
        ? null
        : { id: shownId, startedAt: new Date(), endedAt: null, summary: null })
    const current = [...rows.values()]
      .filter((message) => message.conversationId === shownId)
      .toSorted((a, b) => a.id - b.id)
    const messages = current.filter((message) => message.state !== 'pending')
    const permission = current.find((message) => message.state === 'pending') ?? null
    snapshot = { ...snapshot, shown, messages, permission, ...next }
    for (const listener of listeners) listener()
  }

  function put(message: StudyMessage) {
    rows.set(message.id, message)
  }

  async function load(signal: AbortSignal) {
    const { dir, missionLine, firstMessage, conversations, repos } = await client.get(
      { id },
      { signal },
    )
    const open = conversations.find((conversation) => conversation.endedAt === null)
    for (const conversation of conversations) {
      for (const message of conversation.messages) rows.set(message.id, message)
    }
    const reflected =
      conversations.some((c) => c.id === conversationId && c.endedAt !== null) &&
      [...rows.values()].some(
        (message) => message.conversationId === conversationId && message.kind === 'reflection',
      )
    // 開いた時は最も新しい終わった会話を出し、出していた会話を振り返って終えたら空の新しい会話にする。
    // 振り返らずに終えた時は、送った行と終わった理由を見せるため、その会話を出したままにする。
    conversationId =
      open?.id ?? (loaded ? (reflected ? null : conversationId) : (conversations[0]?.id ?? null))
    loaded = true
    set({
      study: { dir, missionLine, firstMessage },
      conversations: conversations.map((c) => ({
        id: c.id,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        summary: c.summary,
      })),
      ongoingId: open?.id ?? null,
      repos,
    })
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
    async reload(): Promise<void> {
      try {
        await load(new AbortController().signal)
      } catch (error) {
        set({ sendError: failureLine(error) })
      }
    },
    /** URL で選んだ Study Conversation を出す。null なら続いている会話か空の新しい会話。 */
    select(conversation: string | null): void {
      selected = conversation
      set({})
    },
    /** 続いている Study Conversation を終える。振り返りの turn は watch で届く。無ければ空の新しい会話を出す。 */
    async end(): Promise<void> {
      if (snapshot.ongoingId === null) {
        conversationId = null
        return set({})
      }
      try {
        await client.conversation.end({ id })
        set({ sendError: null })
      } catch (error) {
        set({ sendError: failureLine(error) })
      }
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
        conversationId = message.conversationId
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
