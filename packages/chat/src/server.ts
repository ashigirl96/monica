import { implement, ORPCError, type ORPCErrorConstructorMap } from '@orpc/server'

import { agentFailed, type ChatAgent, ChatFailure, internals } from './chat-agent.ts'
import { type askErrors, type ChatEvent, contract } from './contract.ts'

export { migrations } from '../migrations/index.ts'
export { type ChatAgent, createChatAgent } from './chat-agent.ts'

const os = implement(contract).$context<{ chatAgent: ChatAgent }>()

type AskErrors = ORPCErrorConstructorMap<typeof askErrors>

// 素の Error は oRPC で「Internal server error」になり理由が消えるので、宣言していない失敗も AGENT_FAILED に包む。
function typed(error: unknown, errors: AskErrors): ORPCError<string, unknown> {
  if (error instanceof ORPCError) return error
  const { failure } =
    error instanceof ChatFailure
      ? error
      : agentFailed(error instanceof Error ? error.message : String(error))
  switch (failure.code) {
    case 'NOT_AUTHENTICATED':
      return errors.NOT_AUTHENTICATED()
    case 'USAGE_LIMIT':
      return errors.USAGE_LIMIT({ data: failure.data })
    case 'AGENT_FAILED':
      return errors.AGENT_FAILED({ data: failure.data })
  }
}

// 途中の失敗は、それまで流した event の後に typed error として届く。
async function* typedFailures(
  answer: AsyncGenerator<ChatEvent>,
  errors: AskErrors,
): AsyncGenerator<ChatEvent> {
  try {
    yield* answer
  } catch (error) {
    throw typed(error, errors)
  }
}

export const router = os.router({
  prepare: os.prepare.handler(({ context }) => {
    internals(context.chatAgent).prepare()
  }),
  // async generator の handler で投げた error は、呼び出しが resolve した後の iteration で届く。
  // CHAT_BUSY を呼び出しの reject にするため、claude を取ってから generator を返す。
  ask: os.ask.handler(async ({ context, input, signal, errors }) => {
    const answer = await internals(context.chatAgent)
      .ask(input, signal)
      .catch((error: unknown) => Promise.reject(typed(error, errors)))
    if (!answer) throw errors.CHAT_BUSY()
    return typedFailures(answer, errors)
  }),
})
