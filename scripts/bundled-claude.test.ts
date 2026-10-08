import { expect, test } from 'bun:test'
import { dirname, join } from 'node:path'

import { bundledClaude } from './bundled-claude.ts'

const sdk = dirname(
  Bun.resolveSync('@anthropic-ai/claude-agent-sdk', join(import.meta.dir, '../packages/chat')),
)

test('the bundled claude is the platform package of the SDK that packages/chat depends on', async () => {
  const { version, claudeCodeVersion } = await Bun.file(join(sdk, 'package.json')).json()

  const claude = bundledClaude()
  const platform = await Bun.file(join(dirname(claude), 'package.json')).json()
  const printed = Bun.spawnSync([claude, '--version'], { env: { HOME: process.env.HOME } })

  expect(platform).toMatchObject({
    name: `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
    version,
  })
  expect(printed.stdout.toString()).toBe(`${claudeCodeVersion} (Claude Code)\n`)
})
