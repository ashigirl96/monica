import type {
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'

import type { ChatEvent } from './contract.ts'
import { agentFailed, ChatFailure } from './failure.ts'

const NOT_AUTHENTICATED_ERRORS: SDKAssistantMessageError[] = [
  'authentication_failed',
  'oauth_org_not_allowed',
  'verification_required',
]

/** result の前に message が尽きた。claude を止めたかと stderr の末尾は ChatAgent が見る。 */
export class EndedEarly extends Error {}

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

// stream_event の input_json_delta から組むと途中で切れた query になるので、閉じた tool_use の input から読む。
function searchesOf(message: SDKAssistantMessage): string[] {
  return message.message.content.flatMap((block) => {
    if (block.type !== 'tool_use' || block.name !== 'WebSearch') return []
    const { query: searched } = block.input as { query?: unknown }
    return typeof searched === 'string' ? [searched] : []
  })
}

/**
 * claude の message を ChatEvent に訳す。成功の result で返り、失敗の result で ChatFailure を、
 * result の前に message が尽きるか投げると EndedEarly を投げる。
 */
export async function* translate(
  messages: AsyncIterator<SDKMessage>,
  log: (line: string) => void,
): AsyncGenerator<ChatEvent, void> {
  let rateLimit: SDKRateLimitInfo | undefined
  let assistantError: SDKAssistantMessageError | undefined
  // CLI は API の stream が切れると答えを最初からやり直し、stream しない request に替えると答えを assistant 1 つで返す。
  let streamedSinceRetry = false
  // for await を抜けると SDK は claude の終了を最大 2 秒待つので、result を受けたら iterator を閉じずに返す。
  for (;;) {
    let next: IteratorResult<SDKMessage>
    try {
      next = await messages.next()
    } catch (error) {
      throw new EndedEarly((error as Error).message)
    }
    if (next.done) throw new EndedEarly('claude exited before it answered')
    const message = next.value
    if (message.type === 'system' && message.subtype === 'init') {
      log(
        `model ${message.model}, ${message.tools.length} tools, ${message.mcp_servers.length} MCP servers`,
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
      for (const searched of searchesOf(message)) yield { type: 'search', query: searched }
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
      const { usage } = message
      log(
        `usage input ${usage.input_tokens}, cache creation ${usage.cache_creation_input_tokens ?? 0}, cache read ${usage.cache_read_input_tokens ?? 0}, output ${usage.output_tokens}`,
      )
      // SDK はこの 0.5〜1.4 秒後に error result を投げ直すが、それを待たない。
      if (message.is_error || message.subtype !== 'success') {
        throw failureOf(message, rateLimit, assistantError)
      }
      return
    }
  }
}
