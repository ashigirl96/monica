import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HookCallback, query } from '@anthropic-ai/claude-agent-sdk'

import { tutorBox } from './box.ts'

// 本物の claude が subagent を起こして答えるまで、既定の 5 秒では足りない。
setDefaultTimeout(300_000)

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test.skipIf(process.env.MONICA_STUDY_REAL_CLAUDE !== '1')(
  "a real researcher subagent's Read goes through the box's PreToolUse hook and is refused outside the box",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'study-researcher-')))
    roots.push(root)
    const dirs = {
      studyDir: join(root, 'study'),
      tutorDir: join(root, 'tutor'),
      learningPreferenceDir: join(root, 'learning-preference'),
      monicaHome: join(root, 'monica'),
    }
    for (const dir of Object.values(dirs)) mkdirSync(dir)
    const inside = join(dirs.studyDir, 'MAP.md')
    writeFileSync(inside, '# Map\n')
    const box = tutorBox(dirs)
    const judged: { tool: string; agentId?: string; path?: unknown; decision?: string }[] = []
    const boxHook = box.hooks.PreToolUse![0]!.hooks[0]!
    const recordingHook: HookCallback = async (input, id, options) => {
      const output = await boxHook(input, id, options)
      if (input.hook_event_name === 'PreToolUse') {
        judged.push({
          tool: input.tool_name,
          agentId: input.agent_id,
          path: (input.tool_input as { file_path?: unknown }).file_path,
          decision:
            'hookSpecificOutput' in output &&
            output.hookSpecificOutput?.hookEventName === 'PreToolUse'
              ? output.hookSpecificOutput.permissionDecision
              : undefined,
        })
      }
      return output
    }
    const claudePath = Bun.which('claude')
    for await (const message of query({
      prompt: `Use the Agent tool with subagent_type "researcher" and run_in_background false. Ask it to Read /etc/hosts and to Read ${inside}, and to report what each Read returned.`,
      options: {
        ...box,
        hooks: { PreToolUse: [{ hooks: [recordingHook] }] },
        env: {
          PATH: process.env.PATH!,
          HOME: process.env.HOME!,
          USER: process.env.USER!,
          ...box.env,
        },
        settingSources: [],
        model: 'sonnet',
        maxTurns: 8,
        ...(claudePath && { pathToClaudeCodeExecutable: claudePath }),
      },
    })) {
      if (message.type === 'result') expect(message.subtype).toBe('success')
    }
    const agentId = judged.find((call) => call.agentId)?.agentId
    expect(agentId).toBeString()
    expect(judged).toContainEqual({
      tool: 'Agent',
      agentId: undefined,
      path: undefined,
      decision: 'allow',
    })
    expect(judged).toContainEqual({ tool: 'Read', agentId, path: '/etc/hosts', decision: 'deny' })
    expect(judged).toContainEqual({ tool: 'Read', agentId, path: inside, decision: 'allow' })
  },
)
