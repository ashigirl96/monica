import { type Command, Option } from 'commander'
import { CliValidationError, createCli, FailedToExitError, type TrpcCliRunParams } from 'trpc-cli'

import { BackendNotRunning, type Client } from './backend.ts'
import { contract, formatters } from './contract.ts'
import { type Format, forwardingRouter } from './forward.ts'

export type Deps = {
  connect: () => Client | null
  terminalSessionId?: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export async function runCli(argv: string[], deps: Deps): Promise<number> {
  const { cli, params, program } = createProgram(argv, deps)
  try {
    await cli.run(params, program)
    return 0
  } catch (error) {
    if (!(error instanceof FailedToExitError)) throw error
    return error.cause instanceof BackendNotRunning ? 2 : error.exitCode
  }
}

export function createProgram(argv: string[], deps: Deps) {
  let program: Command | undefined
  const router = forwardingRouter(contract, formatters, {
    connect() {
      const client = deps.connect()
      if (!client) throw new BackendNotRunning()
      return client
    },
    format: () => program!.opts<{ format: Format }>().format,
    terminalSessionId: deps.terminalSessionId,
    write: deps.stdout,
  })
  const cli = createCli({ router, name: 'tania' })
  const params: TrpcCliRunParams = {
    argv,
    prompts: false,
    logger: {
      info: (...args) => deps.stdout(line(args)),
      error: (...args) => deps.stderr(line(args)),
    },
    formatError: (error) =>
      error instanceof CliValidationError
        ? usageError(error.message)
        : error instanceof Error
          ? error.message
          : String(error),
    // trpc-cli は自分で process.exit を呼ぶので、抜けずに FailedToExitError を投げ返させて写像する。
    process: { exit: () => undefined as never },
  }
  program = cli.buildProgram(params) as Command
  program.addOption(
    new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
  )
  // trpc-cli は途中の command（workbench など）の出力先と exit を差し替えないので、全 command に揃える。
  // Skill は stderr の 1 行目で失敗の理由を読むので、usage エラーにも help を続けない。
  forEachCommand(program, (command) =>
    command
      .exitOverride((exit) => {
        throw new FailedToExitError(exit.message, { exitCode: exit.exitCode, cause: exit })
      })
      .showHelpAfterError(false)
      .configureOutput({
        writeOut: deps.stdout,
        writeErr: deps.stderr,
        outputError: (text, write) => write(`${usageError(text)}\n`),
      }),
  )
  return { cli, params, program }
}

function forEachCommand(command: Command, visit: (command: Command) => void) {
  visit(command)
  for (const child of command.commands) forEachCommand(child, visit)
}

// commander のエラーは "error: " で始まり、trpc-cli の入力エラーは空行の後に help が続く。
function usageError(text: string): string {
  const [reason = ''] = text.split('\n\n')
  const oneLine = reason
    .replace(/^error: /, '')
    .replaceAll('\n', ' ')
    .trim()
  return `BAD_REQUEST: ${oneLine}`
}

function line(args: unknown[]): string {
  const text = args.map(String).join(' ')
  return text.endsWith('\n') ? text : `${text}\n`
}
