import { type ChildProcessByStdio, spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

import type { Options } from '@anthropic-ai/claude-agent-sdk'

import { SYSTEM_PROMPT } from './prompt.ts'

export type Claude = ChildProcessByStdio<Writable, Readable, null>

// Backend の env は Monica を起こした shell しだいで、認証・接続先・effort を替える key が届くので、通す key だけで組む（ADR-0033）。
const PASSED_ENV_KEYS = ['USER', 'HOME']
const ADDED_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_RESTRICTED: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_MAX_RETRIES: '4',
}

function claudeEnv(): { [key: string]: string } {
  const env: { [key: string]: string } = { ...ADDED_ENV }
  for (const key of PASSED_ENV_KEYS) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

// SDK の close() と AbortController では turn の途中の claude が数秒 delta を出し続けるので、
// child を自分で持ち、止めるときは SIGKILL を送る（ADR-0031）。
export function claudeOptions(deps: {
  cwd: string
  claudePath: string | undefined
  spawned(claude: Claude): void
}): Options {
  return {
    model: 'haiku',
    effort: 'low',
    systemPrompt: SYSTEM_PROMPT,
    // 渡さないと CLI が最初の user message を丸ごと入れた title 生成の request を別に出す。
    title: 'Chat',
    cwd: deps.cwd,
    settingSources: [],
    skills: [],
    strictMcpConfig: true,
    tools: [],
    disallowedTools: ['mcp__*'],
    permissionPrompts: 'none',
    persistSession: false,
    settings: { crossSessionInbound: 'refuse' },
    includePartialMessages: true,
    ...(deps.claudePath && { pathToClaudeCodeExecutable: deps.claudePath }),
    env: claudeEnv(),
    spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
      // SDK はこの child の stderr を読まないので、pipe にすると詰まって claude が止まる。
      const claude = spawn(command, args, {
        cwd,
        env,
        signal,
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      deps.spawned(claude)
      return claude
    },
  }
}
