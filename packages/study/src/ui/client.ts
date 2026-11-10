import { ORPCError } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'

import type { contract } from '../contract.ts'

export type StudyClient = ContractRouterClient<typeof contract>

export function failureLine(error: unknown): string {
  if (error instanceof ORPCError && error.code === 'CONFLICT') {
    return 'Tutor がまだ答えている。答え終わってから送る'
  }
  if (error instanceof ORPCError && error.code === 'TOO_MANY_REQUESTS') {
    return '他の Study で Tutor が答えている。どれかが終わってから送る'
  }
  return `送れなかった: ${error instanceof Error ? error.message : String(error)}`
}
