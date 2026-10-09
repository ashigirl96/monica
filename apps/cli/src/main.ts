#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'

import { commands as taskCommands } from '@monica/task/cli'
import { commands as workbenchCommands } from '@monica/workbench/cli'

import { type Client, connect } from './backend.ts'
import { answerChromeExtension, CHROME_EXTENSION_ORIGIN } from './native-host.ts'

type Connect = (options?: { retry?: boolean }) => Client | null

type Command = {
  path: readonly string[]
  description: string
  run: (argv: string[], deps: { connect: Connect }) => Promise<number>
}

const home = process.env.MONICA_HOME || join(homedir(), '.monica')
const argv = process.argv.slice(2)
const deps: { connect: Connect } = { connect: (options) => connect(home, options) }

// manifest の path は引数を持てないので、Native Messaging の host は Chromium が第 1 引数に渡す origin で見分ける。
if (argv[0]?.startsWith(CHROME_EXTENSION_ORIGIN)) process.exit(await answerChromeExtension(home))

// trpc-cli と contract の実体の import だけで compiled の起動が約 30ms 延びるので、手書き command はその前に振り分ける。
const commands: readonly Command[] = [...workbenchCommands, ...taskCommands]
const command = commands.find((c) => c.path.every((part, i) => argv[i] === part))
if (command) process.exit(await command.run(argv.slice(command.path.length), deps))

const { runCli } = await import('./program.ts')
process.exit(
  await runCli(argv, {
    ...deps,
    terminalSessionId: process.env.MONICA_TERMINAL_SESSION_ID || undefined,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }),
)
