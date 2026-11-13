import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'

import type { contract, Segment } from '../../contract.ts'
import { isUnreachable, viaNativeHost } from '../native-host.ts'
import type { PageTranslationState, SegmentsReply } from './translator.ts'

export type { PageTranslationState, SegmentsReply } from './translator.ts'

/** Browser Tab に注入した script が service worker に送る message。Native Messaging は service worker からしか呼べないため。 */
export type PageTranslationMessage =
  | { type: 'monica.translateSegments'; segments: Segment[] }
  | { type: 'monica.pageTranslationState'; state: PageTranslationState }

export const PAGE_TRANSLATION_COMMAND = 'page-translation'

const BADGES: Record<PageTranslationState['kind'], string> = {
  translating: '…',
  translated: '',
  original: '',
  failed: '!',
}

/** Page Translation の状態を、その Browser Tab の拡張のアイコンに出す。失敗の理由は tooltip に出す。 */
export function showPageTranslationState(tabId: number, state: PageTranslationState): void {
  void chrome.action.setBadgeText({ tabId, text: BADGES[state.kind] })
  void chrome.action.setTitle({
    tabId,
    title: state.kind === 'failed' ? `Page Translation failed: ${state.reason}` : '',
  })
}

/** ⌥A を受けた service worker が、Current Page に script を注入する。chrome:// などで断られたらバッジに出す。 */
export async function injectPageTranslation(tabId: number, scriptFile: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] })
  } catch (error) {
    showPageTranslationState(tabId, {
      kind: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

type Client = ContractRouterClient<{ chat: Pick<typeof contract, 'translateSegments'> }>

async function translateSegments(host: string, segments: Segment[]): Promise<SegmentsReply> {
  const client: Client = createORPCClient(new RPCLink(viaNativeHost(host)))
  try {
    return await client.chat.translateSegments({ segments })
  } catch (error) {
    if (error instanceof ORPCError && error.code === 'CHAT_BUSY') return { busy: true }
    if (isUnreachable(error)) return { failed: 'the monica desktop is not running' }
    if (error instanceof ORPCError && error.code === 'AGENT_FAILED') {
      return { failed: `${error.message}: ${(error.data as { detail: string }).detail}` }
    }
    return { failed: error instanceof Error ? error.message : String(error) }
  }
}

/** 自分宛てでない message には undefined を返し、他の listener に任せる。 */
export function relayPageTranslation(
  host: string,
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<SegmentsReply | undefined> | undefined {
  if (!isMessage(message)) return undefined
  if (message.type === 'monica.translateSegments') return translateSegments(host, message.segments)
  const tabId = sender.tab?.id
  if (tabId !== undefined) showPageTranslationState(tabId, message.state)
  return Promise.resolve(undefined)
}

function isMessage(message: unknown): message is PageTranslationMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  if (message.type === 'monica.translateSegments') {
    return 'segments' in message && Array.isArray(message.segments)
  }
  if (message.type === 'monica.pageTranslationState') {
    return 'state' in message && typeof message.state === 'object' && message.state !== null
  }
  return false
}
