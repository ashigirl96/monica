import { ORPCError } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'

import { type contract, type StudyRefusal, studyErrors } from '../contract.ts'

export type StudyClient = ContractRouterClient<typeof contract>

const refusalLines = {
  'turn-running': 'Tutor がまだ答えている。答え終わってから送る',
  'conversation-ending': '会話を終えている。終わってから送る',
  'playground-cleaning': 'Playground を片付けている。終わってから送る',
  'study-removing': 'この Study は消している途中',
  'tutor-capacity': '他の Study で Tutor が答えている。どれかが終わってから送る',
} satisfies Record<StudyRefusal, string>

export function failureLine(error: unknown): string {
  if (error instanceof ORPCError && error.code in studyErrors) {
    const refused = studyErrors.CONFLICT.data.safeParse(error.data)
    if (refused.success) return refusalLines[refused.data.reason]
  }
  return `送れなかった: ${error instanceof Error ? error.message : String(error)}`
}
