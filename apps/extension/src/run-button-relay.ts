import { viaNativeHost } from '@monica/chat/native-host'
import type { contract as taskContract, RunButtonsOutput } from '@monica/task/contract'
import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'

/** content script が service worker に送る message。content script は Native Messaging を呼べないため。 */
export type RunButtonRequest =
  | { type: 'monica.runButtons'; refs: string[] }
  | { type: 'monica.runFromButton'; ref: string }
  | { type: 'monica.reopenFromButton'; ref: string }

/** null なら Backend に届かなかった。 */
export type RunButtonsReply = RunButtonsOutput | null

export type PressReply = { accepted: true } | { accepted: false; reason: string }

type Client = ContractRouterClient<{
  task: Pick<typeof taskContract, 'runButtons' | 'runFromButton' | 'reopenFromButton'>
}>

/** 自分宛てでない message には undefined を返し、他の listener に任せる。 */
export function relayRunButton(
  host: string,
  message: unknown,
): Promise<RunButtonsReply | PressReply> | undefined {
  if (!isRequest(message)) return undefined
  const client: Client = createORPCClient(new RPCLink(viaNativeHost(host)))
  switch (message.type) {
    case 'monica.runButtons':
      return tellButtons(client, message.refs)
    case 'monica.runFromButton':
      return press(() => client.task.runFromButton({ ref: message.ref }))
    case 'monica.reopenFromButton':
      return press(() => client.task.reopenFromButton({ ref: message.ref }))
  }
}

// host が無い・Backend が居ない・古い token は、どれも desktop を起こせば直るので、まとめて null にする。
async function tellButtons(client: Client, refs: string[]): Promise<RunButtonsReply> {
  try {
    return await client.task.runButtons({ refs })
  } catch {
    return null
  }
}

async function press(call: () => Promise<unknown>): Promise<PressReply> {
  try {
    await call()
    return { accepted: true }
  } catch (error) {
    if (error instanceof ORPCError) return { accepted: false, reason: error.message }
    return { accepted: false, reason: 'the monica desktop is not running' }
  }
}

function isRequest(message: unknown): message is RunButtonRequest {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  if (message.type === 'monica.runButtons') {
    return 'refs' in message && Array.isArray(message.refs)
  }
  if (message.type === 'monica.runFromButton' || message.type === 'monica.reopenFromButton') {
    return 'ref' in message && typeof message.ref === 'string'
  }
  return false
}
