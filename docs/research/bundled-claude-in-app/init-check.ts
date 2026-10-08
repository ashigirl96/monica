// usage: bun run init-check.ts <claude> <空の cwd>
// prompt を送らずに startup() の initialize までを通し、その claude が起きるかだけを見る（plan の使用量を使わない）。
import { startup } from '@anthropic-ai/claude-agent-sdk'
const [claude, cwd] = process.argv.slice(2)
let stderr = ''
const t0 = performance.now()
try {
  const warm = await startup({
    options: {
      pathToClaudeCodeExecutable: claude, cwd, settingSources: [], tools: [], skills: [], strictMcpConfig: true, persistSession: false,
      env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      stderr: (d) => { stderr = (stderr + d).slice(-1500) },
    },
    initializeTimeoutMs: 20000,
  })
  console.log(JSON.stringify({ ok: true, readyMs: performance.now() - t0 }))
  warm.close()
} catch (e) {
  console.log(JSON.stringify({ ok: false, ms: performance.now() - t0, message: (e as Error).message.slice(0, 400), stderr }))
}
await Bun.sleep(1500)
process.exit(0)
