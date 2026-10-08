import { implement } from '@orpc/server'

import { type ChatAgent, internals } from './chat-agent.ts'
import { contract } from './contract.ts'

export { migrations } from '../migrations/index.ts'
export { type ChatAgent, createChatAgent } from './chat-agent.ts'

const os = implement(contract).$context<{ chatAgent: ChatAgent }>()

export const router = os.router({
  prepare: os.prepare.handler(({ context }) => {
    internals(context.chatAgent).prepare()
  }),
  // async generator の handler で投げた error は、呼び出しが resolve した後の iteration で届く。
  // CHAT_BUSY を呼び出しの reject にするため、claude を取ってから generator を返す。
  ask: os.ask.handler(async ({ context, input, signal, errors }) => {
    const answer = await internals(context.chatAgent).ask(input, signal)
    if (!answer) throw errors.CHAT_BUSY()
    return answer
  }),
})
