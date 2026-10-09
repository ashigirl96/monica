// テストの claude。Agent SDK と stream-json を話し、受けたものを argv[2] の記録の file に JSON 行で書く。
// argv[3] の場面（testing.ts の FakeScenario）のとおりに答えるか、失敗する。
// 質問に HOLD を含むと、最初の text の delta の後に止まり、stdin の EOF と SIGTERM では抜けない。
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { FAKE_RESETS_AT as RESETS_AT, type FakeScenario } from './testing.ts'

const [recordPath, scenario, ...argv] = process.argv.slice(2) as [string, FakeScenario, ...string[]]
if (!recordPath || !scenario) {
  throw new Error('usage: fake-claude.ts <record file> <scenario> <claude args>…')
}

const FAKE_TEXT = ['Two', ' is', ' the answer.']
const SAFETY_EXIT_MS = 30_000
// login 無しの claude は result の後も抜けるまでに時間がかかる。ChatAgent がそれを待たないことを見るため。
const LINGER_MS = 5_000

const record = (line: object) =>
  appendFileSync(recordPath, `${JSON.stringify({ pid: process.pid, ...line })}\n`)
const send = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`)

record({ kind: 'start', argv, env: process.env, cwd: process.cwd() })

if (scenario === 'exit-at-start') {
  process.stderr.write('claude: the config is broken\n')
  process.exit(1)
}

const session_id = crypto.randomUUID()
let holding = false

function hold(ms: number) {
  holding = true
  setTimeout(() => process.exit(1), ms)
}

function init() {
  send({
    type: 'system',
    subtype: 'init',
    session_id,
    uuid: crypto.randomUUID(),
    model: 'claude-haiku-5-5',
    tools: [],
    mcp_servers: [],
    cwd: process.cwd(),
    apiKeySource: 'none',
    claude_code_version: '2.1.293',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
  })
}

function streamDelta(delta: object) {
  send({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id,
  })
}

const streamText = (texts: string[]) => {
  for (const text of texts) streamDelta({ type: 'text_delta', text })
}

function assistant(text: string, error?: string) {
  send({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: error ? '<synthetic>' : 'claude-haiku-5-5',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    ...(error && { error }),
    uuid: crypto.randomUUID(),
    session_id,
  })
}

function result(text: string, failed?: { status: number | null }) {
  send({
    type: 'result',
    subtype: 'success',
    is_error: failed !== undefined,
    ...(failed && { api_error_status: failed.status }),
    result: text,
    stop_reason: failed ? 'stop_sequence' : 'end_turn',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    session_id,
    uuid: crypto.randomUUID(),
  })
}

function apiRetry(attempt: number, status: number | null, error: string) {
  send({
    type: 'system',
    subtype: 'api_retry',
    attempt,
    max_retries: 4,
    retry_delay_ms: 1,
    error_status: status,
    error,
    session_id,
    uuid: crypto.randomUUID(),
  })
}

function rateLimit(info: object) {
  send({ type: 'rate_limit_event', rate_limit_info: info, session_id, uuid: crypto.randomUUID() })
}

const ANSWER = FAKE_TEXT.join('')

function answer(question: string) {
  init()
  const [first, ...rest] = FAKE_TEXT
  streamText([first!])
  if (question.includes('HOLD')) {
    holding = true
    process.on('SIGTERM', () => record({ kind: 'sigterm' }))
    setTimeout(() => process.exit(1), SAFETY_EXIT_MS)
    return
  }
  streamDelta({ type: 'thinking_delta', thinking: 'Adding one and one.' })
  streamText(rest)
  assistant(ANSWER)
  if (scenario === 'usage-warning') {
    rateLimit({
      status: 'allowed_warning',
      resetsAt: RESETS_AT,
      rateLimitType: 'five_hour',
      utilization: 0.91,
      surpassedThreshold: 0.9,
    })
  } else {
    rateLimit({ status: 'allowed', resetsAt: RESETS_AT, rateLimitType: 'five_hour' })
  }
  result(ANSWER)
}

// research（docs/research/chat-failures.md の §2）で本物の claude が流した並び。
const scenarios: Record<Exclude<FakeScenario, 'exit-at-start'>, (question: string) => void> = {
  answer,
  'usage-warning': answer,
  'not-logged-in': () => {
    init()
    assistant('Not logged in · Please run /login', 'authentication_failed')
    result('Not logged in · Please run /login', { status: null })
    hold(LINGER_MS)
  },
  'usage-limit': () => {
    init()
    rateLimit({ status: 'rejected', resetsAt: RESETS_AT, rateLimitType: 'five_hour' })
    const text = "You've hit your session limit · resets 10am (Asia/Tokyo)"
    assistant(text, 'rate_limit')
    result(text, { status: 429 })
  },
  throttled: () => {
    init()
    apiRetry(1, 429, 'rate_limit')
    rateLimit({ status: 'rejected', rateLimitType: 'five_hour' })
    const text = 'API Error: Server is temporarily limiting requests (not your usage limit)'
    assistant(text, 'rate_limit')
    result(text, { status: 429 })
  },
  overloaded: () => {
    init()
    for (let attempt = 1; attempt <= 4; attempt++) apiRetry(attempt, 529, 'overloaded')
    const text = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary'
    assistant(text, 'server_error')
    result(text, { status: 529 })
  },
  billing: () => {
    init()
    const text = 'Credit balance is too low'
    assistant(text, 'billing_error')
    result(text, { status: 400 })
  },
  'max-output-tokens': () => {
    init()
    streamText(FAKE_TEXT.slice(0, 2))
    const text = "API Error: Claude's response exceeded the 60 output token maximum."
    assistant(text, 'max_output_tokens')
    result(text, { status: null })
  },
  'exit-mid-answer': () => {
    init()
    streamText(FAKE_TEXT.slice(0, 1))
    process.stderr.write('claude: out of memory\n')
    process.exit(1)
  },
  // API の stream が切れると、CLI は答えを最初からやり直す。
  restart: () => {
    init()
    streamText(['Tw', 'o'])
    apiRetry(1, null, 'unknown')
    streamText(FAKE_TEXT)
    assistant(ANSWER)
    result(ANSWER)
  },
  // stream を毎回切られると、CLI は 2 回目から stream しない request に替え、答えを assistant 1 つで返す。
  unstreamed: () => {
    init()
    streamText(['Tw'])
    apiRetry(1, null, 'unknown')
    assistant(ANSWER)
    result(ANSWER)
  },
}

type Incoming =
  | { type: 'control_request'; request_id: string; request: { subtype: string } }
  | { type: 'user'; message: { content: string | { type: string; text?: string }[] } }
  | { type: string }

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line) as Incoming
  if (message.type === 'control_request' && 'request_id' in message) {
    if (message.request.subtype === 'initialize') {
      record({ kind: 'initialize', request: message.request })
    }
    send({
      type: 'control_response',
      response: { subtype: 'success', request_id: message.request_id, response: {} },
    })
  } else if (message.type === 'user' && 'message' in message) {
    const { content } = message.message
    record({ kind: 'user', content })
    const text = typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('')
    scenarios[scenario as Exclude<FakeScenario, 'exit-at-start'>](text)
  }
})
lines.on('close', () => {
  record({ kind: 'eof' })
  if (!holding) process.exit(0)
})
