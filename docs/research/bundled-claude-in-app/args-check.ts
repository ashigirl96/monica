// usage: bun run args-check.ts <claude> <空の cwd>
// ADR-0033 の options で SDK が claude に渡す引数を出す。prompt は送らない。
import { spawn } from 'node:child_process'
import { type SpawnedProcess, startup } from '@anthropic-ai/claude-agent-sdk'
const [claude, cwd] = process.argv.slice(2)
let args: string[] = []
const warm = await startup({
  options: {
    model: 'haiku', effort: 'low', cwd, settingSources: [], skills: [], tools: [], strictMcpConfig: true,
    disallowedTools: ['mcp__*'], permissionPrompts: 'none', persistSession: false,
    systemPrompt: 'You answer questions about the web page the user is reading. Reply in plain text.',
    includePartialMessages: true, pathToClaudeCodeExecutable: claude,
    env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    spawnClaudeCodeProcess: (o) => {
      args = o.args
      return spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'ignore'], signal: o.signal }) as unknown as SpawnedProcess
    },
  },
})
warm.close()
console.log(JSON.stringify(args))
await Bun.sleep(1500)
process.exit(0)
