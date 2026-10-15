import { expect, test } from 'bun:test'

import type {
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

import type { ChatEvent } from './contract.ts'
import { ChatFailure } from './failure.ts'
import { EndedEarly, translate } from './translate.ts'

// 並びは research（docs/research/chat-failures.md の §2）で本物の claude が流したもの。
const RESETS_AT = 1_800_000_000
const session_id = 'session'
const uuid = '00000000-0000-4000-8000-000000000000'

const init = () =>
  ({
    type: 'system',
    subtype: 'init',
    session_id,
    uuid,
    model: 'claude-haiku-5-5',
    tools: [],
    mcp_servers: [],
  }) as unknown as SDKSystemMessage

const streamDelta = (delta: object) =>
  ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta },
    parent_tool_use_id: null,
    uuid,
    session_id,
  }) as SDKPartialAssistantMessage

const streamText = (texts: string[]) =>
  texts.map((text) => streamDelta({ type: 'text_delta', text }))

const assistant = (content: object[], error?: SDKAssistantMessageError) =>
  ({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: error ? '<synthetic>' : 'claude-haiku-5-5',
      content,
    } as unknown as SDKAssistantMessage['message'],
    parent_tool_use_id: null,
    ...(error && { error }),
    uuid,
    session_id,
  }) as SDKAssistantMessage

const assistantText = (text: string, error?: SDKAssistantMessageError) =>
  assistant([{ type: 'text', text }], error)

// CLI は content block ごとに assistant を 1 つ流し、tool_use の input は block が閉じてから丸ごと載る。
function webSearch(query: string, results: string): SDKMessage[] {
  const id = 'toolu_search'
  const json = JSON.stringify({ query })
  const half = Math.floor(json.length / 2)
  return [
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id, name: 'WebSearch', input: {} },
      },
      parent_tool_use_id: null,
      uuid,
      session_id,
    } as SDKPartialAssistantMessage,
    ...[json.slice(0, half), json.slice(half)].map((partial_json) =>
      streamDelta({ type: 'input_json_delta', partial_json }),
    ),
    assistant([{ type: 'tool_use', id, name: 'WebSearch', input: { query } }]),
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: results }],
      },
      parent_tool_use_id: null,
      uuid,
      session_id,
    } as SDKUserMessage,
  ]
}

const resultFields: Omit<
  SDKResultMessage,
  'type' | 'subtype' | 'is_error' | 'stop_reason' | 'result' | 'errors'
> = {
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: 1,
  total_cost_usd: 0,
  usage: {
    input_tokens: 3,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 7,
    output_tokens: 11,
  } as SDKResultMessage['usage'],
  modelUsage: {},
  permission_denials: [],
  session_id,
  uuid,
}

const result = (text: string, failed?: { status: number | null }) =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: failed !== undefined,
    ...(failed && { api_error_status: failed.status }),
    result: text,
    stop_reason: failed ? 'stop_sequence' : 'end_turn',
    ...resultFields,
  }) as SDKResultMessage

const apiRetry = (attempt: number, error_status: number | null, error: SDKAssistantMessageError) =>
  ({
    type: 'system',
    subtype: 'api_retry',
    attempt,
    max_retries: 4,
    retry_delay_ms: 1,
    error_status,
    error,
    session_id,
    uuid,
  }) as SDKAPIRetryMessage

const rateLimit = (rate_limit_info: SDKRateLimitInfo) =>
  ({ type: 'rate_limit_event', rate_limit_info, session_id, uuid }) as SDKRateLimitEvent

const FAKE_TEXT = ['Two', ' is', ' the answer.']
const ANSWER = FAKE_TEXT.join('')

const answer = (rateLimitInfo: SDKRateLimitInfo) => [
  init(),
  ...streamText(FAKE_TEXT.slice(0, 1)),
  streamDelta({ type: 'thinking_delta', thinking: 'Adding one and one.' }),
  ...streamText(FAKE_TEXT.slice(1)),
  assistantText(ANSWER),
  rateLimit(rateLimitInfo),
  result(ANSWER),
]

function recorded(messages: SDKMessage[], { throws }: { throws?: Error } = {}) {
  const calls: ('next' | 'return')[] = []
  let at = 0
  const iterator: AsyncIterator<SDKMessage> = {
    async next() {
      calls.push('next')
      const message = messages[at++]
      if (message) return { done: false, value: message }
      if (throws) throw throws
      return { done: true, value: undefined }
    },
    async return() {
      calls.push('return')
      return { done: true, value: undefined }
    },
  }
  return { iterator, calls }
}

async function translated(
  messages: SDKMessage[],
  options?: { throws?: Error },
): Promise<{ events: ChatEvent[]; error: unknown; lines: string[] }> {
  const { iterator } = recorded(messages, options)
  const events: ChatEvent[] = []
  const lines: string[] = []
  try {
    for await (const event of translate(iterator, (line) => lines.push(line))) events.push(event)
  } catch (error) {
    return { events, error, lines }
  }
  return { events, error: undefined, lines }
}

const failureOf = (error: unknown) => (error instanceof ChatFailure ? error.failure : error)

test('the text deltas of claude come in order, leaving out the thinking, and the answer ends at the result', async () => {
  const { events, error } = await translated(
    answer({ status: 'allowed', resetsAt: RESETS_AT, rateLimitType: 'five_hour' }),
  )

  expect(error).toBeUndefined()
  expect(events).toEqual(FAKE_TEXT.map((text) => ({ type: 'text', text })))
})

// for await を抜けると SDK は claude の終了を最大 2 秒待つ。
test('after a successful result, translate neither reads on nor closes the messages', async () => {
  const messages = [...answer({ status: 'allowed' }), assistantText('after the result')]
  const { iterator, calls } = recorded(messages)

  await Array.fromAsync(translate(iterator, () => {}))

  expect(calls).toEqual(Array.from({ length: messages.length - 1 }, () => 'next'))
})

test('the init and the result of claude are logged with the model, the tools, the MCP servers and the usage', async () => {
  const { lines } = await translated(answer({ status: 'allowed' }))

  expect(lines).toEqual([
    'model claude-haiku-5-5, 0 tools, 0 MCP servers',
    'usage input 3, cache creation 5, cache read 7, output 11',
  ])
})

test('a claude at the plan limit fails as USAGE_LIMIT with the kind of limit and when it resets', async () => {
  const text = "You've hit your session limit · resets 10am (Asia/Tokyo)"

  const { events, error } = await translated([
    init(),
    rateLimit({ status: 'rejected', resetsAt: RESETS_AT, rateLimitType: 'five_hour' }),
    assistantText(text, 'rate_limit'),
    result(text, { status: 429 }),
  ])

  expect(events).toEqual([])
  expect(failureOf(error)).toEqual({
    code: 'USAGE_LIMIT',
    data: { rateLimitType: 'five_hour', resetsAt: RESETS_AT },
  })
})

// 上限の header の無い 429 は API の一時的な失敗で、rejected でも resetsAt を持たない。
test('a 429 without the headers of a plan limit fails as AGENT_FAILED after its retry, not as USAGE_LIMIT', async () => {
  const text = 'API Error: Server is temporarily limiting requests (not your usage limit)'

  const { events, error } = await translated([
    init(),
    apiRetry(1, 429, 'rate_limit'),
    rateLimit({ status: 'rejected', rateLimitType: 'five_hour' }),
    assistantText(text, 'rate_limit'),
    result(text, { status: 429 }),
  ])

  expect(events).toEqual([{ type: 'retry', attempt: 1 }])
  expect(failureOf(error)).toEqual({ code: 'AGENT_FAILED', data: { detail: text } })
})

test('an overloaded API that outlasts the retries fails, after a retry event for each attempt, as AGENT_FAILED with the result of claude', async () => {
  const text = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary'

  const { events, error } = await translated([
    init(),
    ...[1, 2, 3, 4].map((attempt) => apiRetry(attempt, 529, 'server_error')),
    assistantText(text, 'server_error'),
    result(text, { status: 529 }),
  ])

  expect(events).toEqual([1, 2, 3, 4].map((attempt) => ({ type: 'retry', attempt })))
  expect(failureOf(error)).toEqual({ code: 'AGENT_FAILED', data: { detail: text } })
})

test('an account without credit fails as AGENT_FAILED', async () => {
  const text = 'Credit balance is too low'

  const { error } = await translated([
    init(),
    assistantText(text, 'billing_error'),
    result(text, { status: 400 }),
  ])

  expect(failureOf(error)).toEqual({ code: 'AGENT_FAILED', data: { detail: text } })
})

test.each(['authentication_failed', 'oauth_org_not_allowed', 'verification_required'] as const)(
  'an assistant error %s fails as NOT_AUTHENTICATED',
  async (assistantError) => {
    const text = 'Not logged in · Please run /login'

    const { events, error } = await translated([
      init(),
      assistantText(text, assistantError),
      result(text, { status: null }),
    ])

    expect(events).toEqual([])
    expect(failureOf(error)).toEqual({ code: 'NOT_AUTHENTICATED' })
  },
)

test('a plan limit with an assistant error of authentication fails as USAGE_LIMIT, which comes first', async () => {
  const text = 'Not logged in · Please run /login'

  const { error } = await translated([
    init(),
    rateLimit({ status: 'rejected', resetsAt: RESETS_AT, rateLimitType: 'five_hour' }),
    assistantText(text, 'authentication_failed'),
    result(text, { status: 429 }),
  ])

  expect(failureOf(error)).toMatchObject({ code: 'USAGE_LIMIT' })
})

test('a result whose subtype is an error fails as AGENT_FAILED with its errors joined by lines, even without is_error', async () => {
  const { error } = await translated([
    init(),
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: false,
      errors: ['the first error', 'the second error'],
      stop_reason: null,
      ...resultFields,
    } as SDKResultMessage,
  ])

  expect(failureOf(error)).toEqual({
    code: 'AGENT_FAILED',
    data: { detail: 'the first error\nthe second error' },
  })
})

test('a detail longer than 2,000 characters is cut to its first 2,000', async () => {
  const text = 'x'.repeat(2001)

  const { error } = await translated([init(), result(text, { status: 500 })])

  expect(failureOf(error)).toEqual({ code: 'AGENT_FAILED', data: { detail: text.slice(0, 2000) } })
})

test('an answer cut off at the output limit fails as AGENT_FAILED after the text that came', async () => {
  const text = "API Error: Claude's response exceeded the 60 output token maximum."

  const { events, error } = await translated([
    init(),
    ...streamText(FAKE_TEXT.slice(0, 2)),
    assistantText(text, 'max_output_tokens'),
    result(text, { status: null }),
  ])

  expect(events).toEqual([
    { type: 'text', text: 'Two' },
    { type: 'text', text: ' is' },
  ])
  expect(failureOf(error)).toEqual({ code: 'AGENT_FAILED', data: { detail: text } })
})

test('an assistant error that claude goes on from is no failure when a successful result follows', async () => {
  const { events, error } = await translated([
    init(),
    ...streamText(FAKE_TEXT.slice(0, 2)),
    assistantText(
      "API Error: Claude's response exceeded the 60 output token maximum.",
      'max_output_tokens',
    ),
    ...streamText(FAKE_TEXT.slice(2)),
    assistantText(ANSWER),
    result(ANSWER),
  ])

  expect(error).toBeUndefined()
  expect(events).toEqual(FAKE_TEXT.map((text) => ({ type: 'text', text })))
})

// API の stream が切れると、CLI は答えを最初からやり直す。
test('an answer that claude starts over after a cut API stream comes as text, a retry, then the text from the start', async () => {
  const { events, error } = await translated([
    init(),
    ...streamText(['Tw', 'o']),
    apiRetry(1, null, 'unknown'),
    ...streamText(FAKE_TEXT),
    assistantText(ANSWER),
    result(ANSWER),
  ])

  expect(error).toBeUndefined()
  expect(events).toEqual([
    { type: 'text', text: 'Tw' },
    { type: 'text', text: 'o' },
    { type: 'retry', attempt: 1 },
    { type: 'text', text: 'Two' },
    { type: 'text', text: ' is' },
    { type: 'text', text: ' the answer.' },
  ])
})

// stream を毎回切られると、CLI は 2 回目から stream しない request に替え、答えを assistant 1 つで返す。
test('an answer that claude gets without streaming after a retry comes whole as one text', async () => {
  const { events, error } = await translated([
    init(),
    ...streamText(['Tw']),
    apiRetry(1, null, 'unknown'),
    assistantText(ANSWER),
    result(ANSWER),
  ])

  expect(error).toBeUndefined()
  expect(events).toEqual([
    { type: 'text', text: 'Tw' },
    { type: 'retry', attempt: 1 },
    { type: 'text', text: 'Two is the answer.' },
  ])
})

test('a WebSearch of claude comes as a search with the whole query, and the text before and after it joins into one answer without the search results', async () => {
  const before = 'Let me look that up. '
  const after = ['He was born on', ' April 30, 1916.']

  const { events, error } = await translated([
    init(),
    ...streamText([before]),
    assistantText(before),
    ...webSearch(
      'Claude Shannon birthday',
      'Web search results for query: "Claude Shannon birthday"\n\nLinks: [{"title":"Claude Shannon","url":"https://en.wikipedia.org/wiki/Claude_Shannon"}]\n\nHe was born April 30, 1916.',
    ),
    ...streamText(after),
    assistantText(after.join('')),
    result(before + after.join('')),
  ])

  expect(error).toBeUndefined()
  expect(events).toEqual([
    { type: 'text', text: before },
    { type: 'search', query: 'Claude Shannon birthday' },
    { type: 'text', text: 'He was born on' },
    { type: 'text', text: ' April 30, 1916.' },
  ])
})

test('a tool_use other than WebSearch comes as no search', async () => {
  const { events } = await translated([
    init(),
    assistant([{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { query: 'a file' } }]),
    result(''),
  ])

  expect(events).toEqual([])
})

test('a rate_limit_event that allows the answer with its utilization comes as no usage', async () => {
  const { events } = await translated(
    answer({
      status: 'allowed',
      resetsAt: RESETS_AT,
      rateLimitType: 'five_hour',
      utilization: 0.5,
    }),
  )

  expect(events.map(({ type }) => type)).toEqual(['text', 'text', 'text'])
})

test('an answer near the plan limit is not a failure and is followed by the usage of the plan', async () => {
  const { events, error } = await translated(
    answer({
      status: 'allowed_warning',
      resetsAt: RESETS_AT,
      rateLimitType: 'five_hour',
      utilization: 0.91,
      surpassedThreshold: 0.9,
    }),
  )

  expect(error).toBeUndefined()
  expect(events.map(({ type }) => type)).toEqual(['text', 'text', 'text', 'usage'])
  expect(events.at(-1)).toEqual({
    type: 'usage',
    utilization: 0.91,
    rateLimitType: 'five_hour',
    resetsAt: RESETS_AT,
  })
})

test('messages that throw before the result end early with the message of the error, after the text that came', async () => {
  const { events, error } = await translated([init(), ...streamText(['Two'])], {
    throws: new Error('Claude Code process exited with code 1'),
  })

  expect(events).toEqual([{ type: 'text', text: 'Two' }])
  expect(error).toBeInstanceOf(EndedEarly)
  expect((error as EndedEarly).message).toBe('Claude Code process exited with code 1')
})

test('messages that end without a result end early as a claude that exited before it answered', async () => {
  const { error } = await translated([init(), ...streamText(['Two'])])

  expect(error).toBeInstanceOf(EndedEarly)
  expect((error as EndedEarly).message).toBe('claude exited before it answered')
})
