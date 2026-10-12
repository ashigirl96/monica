// テストの claude。Agent SDK と stream-json を話し、受けたものを argv[2] の記録の file に JSON 行で書く。
// argv[3] の場面（testing.ts の FakeScenario）のとおりに答えるか、失敗する。
// 質問に HOLD を含むと、最初の text の delta の後に止まり、stdin の EOF と SIGTERM では抜けない。
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { FAKE_MODELS, type FakeScenario } from './testing.ts'

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
  result(ANSWER)
}

// research（docs/research/chat-failures.md の §2）で本物の claude が流した並び。
const scenarios: Record<Exclude<FakeScenario, 'exit-at-start'>, (question: string) => void> = {
  answer,
  'not-logged-in': () => {
    init()
    assistant('Not logged in · Please run /login', 'authentication_failed')
    result('Not logged in · Please run /login', { status: null })
    hold(LINGER_MS)
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
}

type Incoming =
  | { type: 'control_request'; request_id: string; request: { subtype: string } }
  | { type: 'user'; message: { content: string | { type: string; text?: string }[] } }
  | { type: string }

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line) as Incoming
  if (message.type === 'control_request' && 'request_id' in message) {
    const initialize = message.request.subtype === 'initialize'
    if (initialize) record({ kind: 'initialize', request: message.request })
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: initialize ? { models: FAKE_MODELS } : {},
      },
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
