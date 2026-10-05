import {
  type AnyContractRouter,
  getEventIteratorSchemaDetails,
  isContractProcedure,
} from '@orpc/contract'
import { type AnyRouter, ORPCError, os } from '@orpc/server'
import type { AnyRouter as CliRouter } from 'trpc-cli'
import { z } from 'zod'

import type { Client } from './backend.ts'

export type Format = 'text' | 'json'

type Forwarding = {
  connect: () => Client
  format: () => Format
  terminalSessionId: string | undefined
  write: (text: string) => void
}

/**
 * trpc-cli は router を in-process で呼ぶので、contract の `cli: true` の葉を「Backend を呼んで整形して
 * 書き、undefined を返す」handler に置き換えた router を渡す。undefined を返すので trpc-cli の logger は何も出さない。
 */
export function forwardingRouter(
  contract: AnyContractRouter,
  formatters: unknown,
  forwarding: Forwarding,
): CliRouter {
  return forward(contract, formatters, forwarding, []) as CliRouter
}

function forward(
  contract: AnyContractRouter,
  formatters: unknown,
  forwarding: Forwarding,
  path: readonly string[],
): AnyRouter | undefined {
  if (isContractProcedure(contract)) {
    const { meta, inputSchema, outputSchema } = contract['~orpc']
    if ((meta as { cli?: boolean }).cli !== true) return undefined
    if (getEventIteratorSchemaDetails(outputSchema)) return undefined
    const format = lookup(formatters, path) as ((output: unknown) => string) | undefined
    if (!format) throw new Error(`no text formatter for ${path.join('.')}`)
    // 呼び手は CLI が動いている Tab で決まるので、flag では受けずに env から埋める。
    const takesCaller =
      inputSchema instanceof z.ZodObject && 'terminalSessionId' in inputSchema.shape
    // output は Backend が検証済みで、この handler は undefined を返すので output schema を持たせない。
    // input の無い procedure も空の object に見せないと、trpc-cli は変換できない input として --json を生やす。
    const cliInput = takesCaller
      ? inputSchema.omit({ terminalSessionId: true })
      : (inputSchema ?? z.object({}))
    const base = os.$meta(meta).input(cliInput)
    return base.handler(async ({ input }) => {
      const remoteInput = takesCaller
        ? { ...(input as object), terminalSessionId: forwarding.terminalSessionId }
        : inputSchema
          ? input
          : undefined
      const output = await callRemote(forwarding.connect(), path, remoteInput)
      const text = forwarding.format() === 'json' ? JSON.stringify(output, null, 2) : format(output)
      forwarding.write(`${text}\n`)
      return undefined
    })
  }
  const children = Object.entries(contract).flatMap(([key, child]) => {
    const forwarded = forward(child, formatters, forwarding, [...path, key])
    return forwarded ? [[key, forwarded] as const] : []
  })
  return Object.fromEntries(children) as AnyRouter
}

async function callRemote(
  client: Client,
  path: readonly string[],
  input: unknown,
): Promise<unknown> {
  const procedure = lookup(client, path) as (input: unknown) => Promise<unknown>
  try {
    return await procedure(input)
  } catch (error) {
    // trpc-cli は ORPCError を cause に剥がして表示するが、remote から来た ORPCError は cause を持たない。
    if (error instanceof ORPCError)
      throw new Error(`${error.code}: ${error.message}`, { cause: error })
    throw error
  }
}

function lookup(root: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | undefined)?.[key],
    root,
  )
}
