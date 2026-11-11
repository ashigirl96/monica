import { basename, join } from 'node:path'

import { ORPCError } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'

import type { contract } from './contract.ts'

type Connect = (options: {
  retry: boolean
}) => { study: ContractRouterClient<typeof contract> } | null

export const commands = [
  {
    path: ['study', 'shell'],
    description: 'Start your shell in the dir of the Study whose id starts with <short id>',
    run: shell,
  },
] as const

// 起動の速さのため、contract や zod の実体を import しない。
async function shell(argv: string[], { connect }: { connect: Connect }): Promise<number> {
  if (argv.length !== 1) {
    console.error('BAD_REQUEST: usage: monica study shell <short id>')
    return 1
  }
  let found: { dir: string; env: Record<string, string>; zdotdir: string }
  try {
    const client = connect({ retry: true })
    if (!client) return backendNotRunning()
    found = await client.study.shell({ prefix: argv[0]! })
  } catch (error) {
    if (error instanceof ORPCError) {
      console.error(`${error.code}: ${error.message}`)
      return 1
    }
    if (error instanceof Error && error.message.startsWith('BACKEND_NOT_RUNNING')) {
      return backendNotRunning()
    }
    throw error
  }

  const userShell = process.env.SHELL || '/bin/zsh'
  const zsh = basename(userShell) === 'zsh'
  const cmd = zsh
    ? [userShell, '-i']
    : [
        '/bin/sh',
        '-c',
        'if [ -f "$1" ]; then . "$1"; fi; exec "$2" -i',
        'sh',
        join(found.dir, 'env/env.sh'),
        userShell,
      ]
  const env = {
    ...process.env,
    ...found.env,
    ...(zsh && { ZDOTDIR: found.zdotdir, MONICA_USER_ZDOTDIR: process.env.ZDOTDIR ?? '' }),
  }
  // 同じ process group にいるので、shell の中の Ctrl-C で CLI が先に終わらないようにする。
  process.on('SIGINT', ignore)
  process.on('SIGQUIT', ignore)
  try {
    await Bun.spawn(cmd, { cwd: found.dir, env, stdio: ['inherit', 'inherit', 'inherit'] }).exited
  } catch (error) {
    console.error(`could not start ${userShell}: ${(error as Error).message}`)
    return 1
  } finally {
    process.off('SIGINT', ignore)
    process.off('SIGQUIT', ignore)
  }
  // shell の exit code は写さない。最後の command の失敗で抜けると、stderr の無い失敗になるため。
  return 0
}

const ignore = () => {}

function backendNotRunning(): number {
  console.error('BACKEND_NOT_RUNNING: start the monica desktop app')
  return 2
}
