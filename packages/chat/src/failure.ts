import type { z } from 'zod'

import type { askErrors } from './contract.ts'

// side panel は detail をそのまま詳しい行に出すので、長い stderr で画面を埋めない。
const MAX_DETAIL_CHARS = 2000

/** claude が答えを返せなかった理由。chat.ask の `.errors()` で宣言した code と data。 */
export type Failure =
  | { code: 'NOT_AUTHENTICATED' }
  | { code: 'USAGE_LIMIT'; data: z.infer<typeof askErrors.USAGE_LIMIT.data> }
  | { code: 'AGENT_FAILED'; data: z.infer<typeof askErrors.AGENT_FAILED.data> }

export class ChatFailure extends Error {
  readonly failure: Failure

  constructor(failure: Failure) {
    super(failure.code)
    this.failure = failure
  }
}

export const shortDetail = (detail: string) => detail.slice(0, MAX_DETAIL_CHARS)

export function agentFailed(detail: string): ChatFailure {
  return new ChatFailure({ code: 'AGENT_FAILED', data: { detail: shortDetail(detail) } })
}
