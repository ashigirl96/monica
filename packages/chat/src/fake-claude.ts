// テストの claude。Agent SDK と stream-json を話し、受けたものを argv[2] の記録の file に JSON 行で書く。
// 質問に HOLD を含むと、最初の text の delta の後に止まり、stdin の EOF と SIGTERM では抜けない。
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [recordPath, ...argv] = process.argv.slice(2)
if (!recordPath) throw new Error('usage: fake-claude.ts <record file> <claude args>…')

const FAKE_TEXT = ['Two', ' is', ' the answer.']
const SAFETY_EXIT_MS = 30_000

const record = (line: object) =>
  appendFileSync(recordPath, `${JSON.stringify({ pid: process.pid, ...line })}\n`)
const send = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`)

record({ kind: 'start', argv, env: process.env, cwd: process.cwd() })

const session_id = crypto.randomUUID()
let holding = false

function streamDelta(delta: object) {
  send({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id,
  })
}

function answer(question: string) {
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
  const [first, ...rest] = FAKE_TEXT
  streamDelta({ type: 'text_delta', text: first })
  if (question.includes('HOLD')) {
    holding = true
    process.on('SIGTERM', () => record({ kind: 'sigterm' }))
    setTimeout(() => process.exit(1), SAFETY_EXIT_MS)
    return
  }
  streamDelta({ type: 'thinking_delta', thinking: 'Adding one and one.' })
  for (const text of rest) streamDelta({ type: 'text_delta', text })
  const result = FAKE_TEXT.join('')
  send({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: result }] },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id,
  })
  send({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    session_id,
    uuid: crypto.randomUUID(),
  })
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
    answer(text)
  }
})
lines.on('close', () => {
  record({ kind: 'eof' })
  if (!holding) process.exit(0)
})
