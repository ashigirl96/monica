import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  type HookCallbackMatcher,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  prewarm,
  query,
  startup,
} from '@anthropic-ai/claude-agent-sdk'

type Mode =
  | 'cold'
  | 'startup'
  | 'prewarm'
  | 'multi'
  | 'baseline'
  | 'init-only'
  | 'init-only-baseline'
  | 'prewarm-only'
  | 'hold-idle'
  | 'hold-turn'

const now = () => performance.now()
const out = (line: object) => console.log(JSON.stringify(line))

type Proc = { pid: number; ppid: number; rssKB: number; comm: string }

function descendants(root = process.pid): Proc[] {
  const ps = Bun.spawnSync(['/bin/ps', '-A', '-o', 'pid=,ppid=,rss=,comm='], { env: {} })
  const rows = ps.stdout
    .toString()
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid, rss, ...comm] = line.trim().split(/\s+/)
      return { pid: Number(pid), ppid: Number(ppid), rssKB: Number(rss), comm: comm.join(' ') }
    })
  const found: Proc[] = []
  const frontier = [root]
  while (frontier.length) {
    const parent = frontier.pop()!
    for (const row of rows) {
      if (row.ppid === parent) {
        found.push(row)
        frontier.push(row.pid)
      }
    }
  }
  return found
    .filter((p) => p.comm !== '/bin/ps')
    .map((p) => ({ ...p, comm: p.comm.replace(/^.*\/node_modules\//, 'node_modules/') }))
}

function inbox() {
  const queue: SDKUserMessage[] = []
  let wake: (() => void) | null = null
  let done = false
  const notify = () => {
    wake?.()
    wake = null
  }
  return {
    push(text: string) {
      queue.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      } as SDKUserMessage)
      notify()
    },
    end() {
      done = true
      notify()
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      while (true) {
        while (queue.length) yield queue.shift()!
        if (done) return
        await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  }
}

export async function main(claudePath: string | undefined, extra: Record<string, unknown> = {}) {
  const mode = (process.argv[2] ?? 'cold') as Mode
  const base = process.env.R257_DIR ?? process.cwd()
  const cwd = join(base, 'cwd-empty')
  mkdirSync(cwd, { recursive: true })

  const stderrLines: string[] = []
  const loaded: { file: string; type: string; reason: string }[] = []
  const hooks: Partial<Record<'InstructionsLoaded', HookCallbackMatcher[]>> = {
    InstructionsLoaded: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === 'InstructionsLoaded') {
              loaded.push({ file: input.file_path, type: input.memory_type, reason: input.load_reason })
            }
            return {}
          },
        ],
      },
    ],
  }

  const isolated: Options = {
    model: 'haiku',
    cwd,
    settingSources: [],
    tools: [],
    skills: [],
    strictMcpConfig: true,
    persistSession: false,
    includePartialMessages: true,
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    hooks,
    stderr: (data) => stderrLines.push(data),
    ...(claudePath && { pathToClaudeCodeExecutable: claudePath }),
  }
  const baseline: Options = {
    model: 'haiku',
    cwd,
    persistSession: false,
    includePartialMessages: true,
    hooks,
    stderr: (data) => stderrLines.push(data),
    ...(claudePath && { pathToClaudeCodeExecutable: claudePath }),
  }

  out({ event: 'start', mode, claudePath: claudePath ?? '(default resolution)', ...extra })

  if (mode === 'init-only' || mode === 'init-only-baseline') {
    const options = mode === 'init-only' ? isolated : baseline
    const n = Number(process.env.R257_N ?? 3)
    for (let i = 0; i < n; i++) {
      const t0 = now()
      const warm = await startup({ options })
      const readyMs = now() - t0
      await Bun.sleep(1500)
      const procs = descendants()
      warm.close()
      await Bun.sleep(1500)
      out({ event: 'startup', i, readyMs, procs, afterClose: descendants().length, bunRssKB: rssKB() })
    }
    return
  }

  if (mode === 'prewarm-only') {
    const n = Number(process.env.R257_N ?? 2)
    for (let i = 0; i < n; i++) {
      const t0 = now()
      const spare = await prewarm({ options: isolated })
      const readyMs = now() - t0
      await Bun.sleep(1500)
      const procs = descendants()
      await spare.close()
      await Bun.sleep(1500)
      out({ event: 'prewarm', i, readyMs, procs, afterClose: descendants().length })
    }
    return
  }

  if (mode === 'hold-idle') {
    if (process.env.R257_BACKENDLIKE) {
      process.on('SIGTERM', () => process.exit(0))
    }
    const warm = await startup({ options: isolated })
    out({ event: 'ready', parent: process.pid, children: descendants().map((p) => p.pid) })
    setInterval(() => {}, 1000)
    void warm
    return
  }

  const prompts =
    mode === 'multi'
      ? [
          'Remember the word "kumquat". Reply with just OK.',
          'What word did I ask you to remember? Reply with the word only.',
          'Write the numbers 1 to 30 separated by spaces. Output nothing else.',
        ]
      : mode === 'hold-turn'
        ? ['Write the numbers 1 to 400 separated by spaces. Output nothing else.']
        : ['Write the numbers 1 to 30 separated by spaces. Output nothing else.']

  const input = inbox()
  let q: Query
  const t0 = now()
  let readyMs: number | undefined
  if (mode === 'startup') {
    const warm = await startup({ options: isolated })
    readyMs = now() - t0
    await Bun.sleep(1000)
    out({ event: 'warm', readyMs, procs: descendants() })
    q = warm.query(input)
  } else if (mode === 'prewarm') {
    // cwd を渡さないと spare は ~/.claude/spares/spare-* に park するので、scratch の下を渡す。
    const parking = join(base, 'parking')
    mkdirSync(parking, { recursive: true })
    const spare = await prewarm({ options: { ...isolated, cwd: parking } })
    readyMs = now() - t0
    await Bun.sleep(1000)
    out({ event: 'warm', readyMs, procs: descendants() })
    q = spare.claim({ prompt: input, options: { cwd, model: 'haiku' } })
    spare.claimed.then(
      (c) => out({ event: 'claimed', claimed: c }),
      (e: Error) => out({ event: 'claim-rejected', message: e.message }),
    )
  } else {
    q = query({ prompt: input, options: mode === 'baseline' ? baseline : isolated })
  }
  if (mode === 'hold-turn' && process.env.R257_BACKENDLIKE) {
    const closing = process.env.R257_BACKENDLIKE === 'close'
    process.on('SIGTERM', () => {
      if (closing) q.close()
      process.exit(0)
    })
  }

  let turn = 0
  let sentAt = now()
  input.push(prompts[0]!)
  if (mode === 'startup' || mode === 'prewarm') sentAt = now()
  let firstDeltaAt: number | undefined
  let initAt: number | undefined
  let deltas = 0
  let text = ''
  const childPidsPerTurn: number[][] = []

  for await (const message of q as AsyncIterable<SDKMessage>) {
    if (message.type === 'system' && message.subtype === 'init') {
      initAt ??= now()
      if (turn === 0) {
        const account = await q.accountInfo().catch((e: Error) => ({ error: e.message }))
        const { email: _e, organization: _o, ...accountSafe } = account as Record<string, unknown>
        out({
          event: 'init',
          sinceStartMs: now() - t0,
          apiKeySource: message.apiKeySource,
          claude_code_version: message.claude_code_version,
          model: message.model,
          tools: message.tools,
          mcp_servers: message.mcp_servers,
          skills: message.skills,
          plugins: message.plugins.map((p) => p.name),
          slash_commands: message.slash_commands.length,
          agents: message.agents,
          output_style: message.output_style,
          permissionMode: message.permissionMode,
          account: accountSafe,
        })
      }
    } else if (message.type === 'stream_event') {
      const ev = message.event
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        deltas++
        if (firstDeltaAt === undefined) {
          firstDeltaAt = now()
          if (mode === 'hold-turn') {
            out({ event: 'streaming', parent: process.pid, children: descendants().map((p) => p.pid) })
          }
        }
      }
    } else if (message.type === 'assistant') {
      for (const block of message.message.content) if (block.type === 'text') text += block.text
    } else if (message.type === 'result') {
      const procs = descendants()
      childPidsPerTurn.push(procs.map((p) => p.pid))
      const r = message as Record<string, unknown>
      out({
        event: 'result',
        turn,
        subtype: message.subtype,
        is_error: message.is_error,
        api_error_status: r.api_error_status,
        result: 'result' in message ? message.result.slice(0, 200) : undefined,
        text: text.slice(0, 200),
        deltas,
        callToFirstDeltaMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - t0,
        sendToFirstDeltaMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - sentAt,
        sendToResultMs: now() - sentAt,
        readyMs,
        cli_duration_ms: message.duration_ms,
        cli_duration_api_ms: message.duration_api_ms,
        cli_ttft_ms: r.ttft_ms,
        cli_time_to_request_ms: r.time_to_request_ms,
        cli_time_to_request_from_spawn_ms: r.time_to_request_from_spawn_ms,
        warm_spare_claimed: r.warm_spare_claimed,
        usage: message.usage,
        models: Object.keys(message.modelUsage ?? {}),
        total_cost_usd: message.total_cost_usd,
        procs,
        bunRssKB: rssKB(),
        instructionsLoaded: loaded,
      })
      turn++
      text = ''
      deltas = 0
      firstDeltaAt = undefined
      if (turn < prompts.length) {
        await Bun.sleep(500)
        sentAt = now()
        input.push(prompts[turn]!)
      } else {
        input.end()
      }
    }
  }
  const endedAt = now()
  await Bun.sleep(300)
  out({
    event: 'end',
    samePidAcrossTurns: new Set(childPidsPerTurn.map((p) => p.join(','))).size === 1,
    childPidsPerTurn,
    leftAfterEnd: descendants(),
    msSinceEnd: now() - endedAt,
    stderrTail: stderrLines.join('').slice(-1500),
  })
}

function rssKB() {
  return Math.round(process.memoryUsage().rss / 1024)
}
