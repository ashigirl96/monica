// Backend 役。probe の .app の Contents/MacOS/monica-backend として compile する。
// usage: monica-backend <run id> <step[*回数],...>   例: env,version*2,ask*3,spare*3,spare-close*2,kill
//   step: env・version・ask・spare・spare-close・kill
// 結果は $MONICA_HOME/results.jsonl に JSON 行で書く（Shell 役は stdout を log に写すだけ）。
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

import {
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  query,
  startup,
} from '@anthropic-ai/claude-agent-sdk'

const home = process.env.MONICA_HOME
const claudePath = process.env.MONICA_CLAUDE_PATH
if (!home || !claudePath) {
  console.error('MONICA_HOME and MONICA_CLAUDE_PATH are required')
  process.exit(1)
}
const runId = process.argv[2] ?? 'run'
const steps = (process.argv[3] ?? 'env').split(',').map((s) => {
  const [name, times] = s.split('*')
  return { name: name!, times: Number(times ?? 1) }
})
const resultsFile = join(home, 'results.jsonl')
const now = () => performance.now()
const out = (line: object) =>
  appendFileSync(resultsFile, `${JSON.stringify({ run: runId, at: new Date().toISOString(), ...line })}\n`)

const launchEnvKeys = Object.keys(process.env).sort()
const launchPath = process.env.PATH

// apps/backend/src/login-shell-path.ts の写し。Backend は起動時に PATH をこれで置き換える。
const DELIMITER = '_MONICA_PATH_DELIMITER_'
function loginShellPath(env: Record<string, string | undefined> = process.env): string {
  const shell = env.SHELL || userInfo().shell || '/bin/zsh'
  const result = Bun.spawnSync(
    [shell, '-ilc', `printf '%s' '${DELIMITER}'; printf '%s' "$PATH"; printf '%s' '${DELIMITER}'`],
    {
      cwd: env.HOME || homedir(),
      env: { ...env, DISABLE_AUTO_UPDATE: 'true' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000,
    },
  )
  const path = result.stdout.toString().split(DELIMITER)[1]
  if (!result.success || !path) throw new Error(`login shell failed: ${result.exitCode}`)
  return path
}
try {
  process.env.PATH = loginShellPath()
} catch (error) {
  out({ event: 'login-path-failed', message: (error as Error).message })
}

type Proc = { pid: number; ppid: number; rssKB: number; comm: string }

function table(): Proc[] {
  const ps = Bun.spawnSync(['/bin/ps', '-A', '-o', 'pid=,ppid=,rss=,comm='], { env: {} })
  return ps.stdout
    .toString()
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid, rss, ...comm] = line.trim().split(/\s+/)
      return { pid: Number(pid), ppid: Number(ppid), rssKB: Number(rss), comm: comm.join(' ') }
    })
}

function descendants(root = process.pid): Proc[] {
  const rows = table()
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
  return found.filter((p) => p.comm !== '/bin/ps')
}

function ancestors(): Proc[] {
  const rows = new Map(table().map((p) => [p.pid, p]))
  const chain: Proc[] = []
  let pid = process.pid
  while (pid > 0) {
    const row = rows.get(pid)
    if (!row) break
    chain.push(row)
    if (pid === 1) break
    pid = row.ppid
  }
  return chain
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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

const chatDir = join(home, 'chat')
mkdirSync(chatDir, { recursive: true })
let stderrTail = ''

// ADR-0033 の options。
function chatOptions(extra: Partial<Options> = {}): Options {
  return {
    model: 'haiku',
    effort: 'low',
    cwd: chatDir,
    settingSources: [],
    skills: [],
    tools: [],
    strictMcpConfig: true,
    disallowedTools: ['mcp__*'],
    permissionPrompts: 'none',
    persistSession: false,
    systemPrompt: 'You answer questions about the web page the user is reading. Reply in plain text.',
    includePartialMessages: true,
    pathToClaudeCodeExecutable: claudePath,
    env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    stderr: (data) => {
      stderrTail = (stderrTail + data).slice(-4000)
    },
    ...extra,
  }
}

const SHORT = 'Write the numbers 1 to 30 separated by spaces. Output nothing else.'
const LONG = 'Write the numbers 1 to 400 separated by spaces. Output nothing else.'

type Timing = { t0: number; sentAt: number; readyMs?: number }

async function answer(step: string, i: number, q: Query, input: ReturnType<typeof inbox>, timing: Timing) {
  let initAt: number | undefined
  let firstDeltaAt: number | undefined
  let deltas = 0
  let account: Promise<unknown> | undefined
  try {
    for await (const message of q as AsyncIterable<SDKMessage>) {
      if (message.type === 'system' && message.subtype === 'init') {
        initAt ??= now()
        account = q.accountInfo().catch((e: Error) => ({ error: e.message }))
        out({
          event: 'init',
          step,
          i,
          apiKeySource: message.apiKeySource,
          claude_code_version: message.claude_code_version,
          model: message.model,
          cwd: message.cwd,
          tools: message.tools,
          mcp_servers: message.mcp_servers,
          skills: message.skills.length,
          plugins: message.plugins.map((p) => p.name),
          slash_commands: message.slash_commands.length,
          agents: message.agents,
          permissionMode: message.permissionMode,
        })
      } else if (message.type === 'stream_event') {
        const ev = message.event
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          deltas++
          firstDeltaAt ??= now()
        }
      } else if (message.type === 'result') {
        const r = message as Record<string, unknown>
        const acc = (await account) as Record<string, unknown> | undefined
        const { email: _e, organization: _o, ...accountSafe } = acc ?? {}
        out({
          event: 'result',
          step,
          i,
          subtype: message.subtype,
          is_error: message.is_error,
          result: 'result' in message ? message.result.slice(0, 120) : undefined,
          deltas,
          readyMs: timing.readyMs,
          callToInitMs: initAt === undefined ? undefined : initAt - timing.t0,
          callToFirstDeltaMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - timing.t0,
          sendToFirstDeltaMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - timing.sentAt,
          sendToResultMs: now() - timing.sentAt,
          cli_ttft_ms: r.ttft_ms,
          cli_time_to_request_ms: r.time_to_request_ms,
          cli_time_to_request_from_spawn_ms: r.time_to_request_from_spawn_ms,
          models: Object.keys(message.modelUsage ?? {}),
          usage: message.usage,
          total_cost_usd: message.total_cost_usd,
          procs: descendants(),
          account: accountSafe,
        })
        input.end()
      }
    }
  } catch (error) {
    out({ event: 'query-threw', step, i, message: (error as Error).message, stderrTail })
  }
  await Bun.sleep(300)
  out({ event: 'after-end', step, i, left: descendants() })
}

async function ask(i: number) {
  const input = inbox()
  const t0 = now()
  const q = query({ prompt: input, options: chatOptions() })
  input.push(SHORT)
  await answer('ask', i, q, input, { t0, sentAt: t0 })
}

async function spare(i: number) {
  const t0 = now()
  const warm = await startup({ options: chatOptions() })
  const readyMs = now() - t0
  await Bun.sleep(1000)
  out({ event: 'warm', step: 'spare', i, readyMs, procs: descendants() })
  const input = inbox()
  const sentAt = now()
  const q = warm.query(input)
  input.push(SHORT)
  await answer('spare', i, q, input, { t0, sentAt, readyMs })
}

async function spareClose(i: number) {
  const t0 = now()
  const warm = await startup({ options: chatOptions() })
  const readyMs = now() - t0
  await Bun.sleep(1000)
  const children = descendants()
  const closedAt = now()
  warm.close()
  const samples: { ms: number; alive: number[] }[] = []
  for (const at of [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 5000, 8000]) {
    await Bun.sleep(Math.max(0, at - (now() - closedAt)))
    samples.push({ ms: at, alive: children.map((p) => p.pid).filter(alive) })
  }
  out({ event: 'spare-close', i, readyMs, children, samples, left: descendants() })
}

async function kill(i: number) {
  let held: ReturnType<typeof spawn> | undefined
  let exited: { ms: number; code: number | null; signal: string | null } | undefined
  let killedAt = 0
  const input = inbox()
  const t0 = now()
  const q = query({
    prompt: input,
    options: chatOptions({
      spawnClaudeCodeProcess: (o) => {
        const child = spawn(o.command, o.args, {
          cwd: o.cwd,
          env: o.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: o.signal,
        })
        child.stderr?.on('data', (d) => {
          stderrTail = (stderrTail + String(d)).slice(-4000)
        })
        child.once('exit', (code, signal) => {
          exited = { ms: now() - killedAt, code, signal }
        })
        held = child
        return child as unknown as SpawnedProcess
      },
    }),
  })
  input.push(LONG)
  let observing: Promise<void> | undefined
  try {
    for await (const message of q as AsyncIterable<SDKMessage>) {
      if (observing || message.type !== 'stream_event') continue
      const ev = message.event
      if (ev.type !== 'content_block_delta' || ev.delta.type !== 'text_delta') continue
      const claudePid = held!.pid!
      const tree = descendants()
      const watched = tree.map((p) => p.pid)
      killedAt = now()
      process.kill(claudePid, 'SIGKILL')
      observing = (async () => {
        const samples: { ms: number; alive: number[] }[] = []
        for (const at of [0, 10, 50, 100, 250, 500, 1000, 2500, 5000]) {
          await Bun.sleep(Math.max(0, at - (now() - killedAt)))
          samples.push({ ms: at, alive: watched.filter(alive) })
        }
        out({
          event: 'kill',
          i,
          sinceCallMs: killedAt - t0,
          claudePid,
          tree,
          samples,
          exited,
          left: descendants(),
        })
      })()
    }
    out({ event: 'kill-iterator-ended', i, sinceKillMs: now() - killedAt })
  } catch (error) {
    out({ event: 'kill-iterator-threw', i, sinceKillMs: now() - killedAt, message: (error as Error).message })
  }
  input.end()
  await observing
}

async function version(i: number) {
  const t0 = now()
  const r = Bun.spawnSync([claudePath!, '--version'], { env: process.env, stdout: 'pipe', stderr: 'pipe' })
  out({
    event: 'version',
    i,
    ms: now() - t0,
    exitCode: r.exitCode,
    signalCode: r.signalCode,
    stdout: r.stdout.toString().trim(),
    stderr: r.stderr.toString().trim().slice(-500),
  })
}

out({ event: 'backend-start', pid: process.pid, steps, claudePath })
for (const { name: step, times } of steps) {
  try {
    if (step === 'env') {
      out({
        event: 'env',
        ancestors: ancestors(),
        launchEnvKeys,
        launchPath,
        loginPath: process.env.PATH,
        authEnv: launchEnvKeys.filter((k) => /^(ANTHROPIC|CLAUDE)/.test(k)),
        chatDirEntries: readdirSync(chatDir),
      })
    } else {
      const run = { version, ask, spare, 'spare-close': spareClose, kill }[step]
      if (!run) throw new Error(`unknown step ${step}`)
      for (let i = 0; i < times; i++) await run(i)
    }
  } catch (error) {
    out({ event: 'step-failed', step, message: (error as Error).message, stack: (error as Error).stack, stderrTail })
  }
}
out({ event: 'done', left: descendants(), chatDirEntries: readdirSync(chatDir) })
process.exit(0)
