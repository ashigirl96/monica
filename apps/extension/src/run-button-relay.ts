import { viaNativeHost } from '@monica/chat/native-host'
import type { contract as taskContract, RunButtonsOutput } from '@monica/task/contract'
import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'

/** content script が service worker に送る message。content script は Native Messaging を呼べないため。 */
export type RunButtonRequest =
  | { type: 'monica.runButtons'; refs: string[] }
  | { type: 'monica.runFromButton'; ref: string }

/** null なら Backend に届かなかった。 */
export type RunButtonsReply = RunButtonsOutput | null

export type RunFromButtonReply = { ran: true } | { ran: false; reason: string }

type Client = ContractRouterClient<{
  task: Pick<typeof taskContract, 'runButtons' | 'runFromButton'>
}>

/** 自分宛てでない message には undefined を返し、他の listener に任せる。 */
export function relayRunButton(
  host: string,
  message: unknown,
): Promise<RunButtonsReply | RunFromButtonReply> | undefined {
  if (!isRequest(message)) return undefined
  const client: Client = createORPCClient(new RPCLink(viaNativeHost(host)))
  if (message.type === 'monica.runButtons') return tellButtons(client, message.refs)
  return runFromButton(client, message.ref)
}

// host が無い・Backend が居ない・古い token は、どれも desktop を起こせば直るので、まとめて null にする。
async function tellButtons(client: Client, refs: string[]): Promise<RunButtonsReply> {
  try {
    return await client.task.runButtons({ refs })
  } catch {
    return null
  }
}

async function runFromButton(client: Client, ref: string): Promise<RunFromButtonReply> {
  try {
    await client.task.runFromButton({ ref })
    return { ran: true }
  } catch (error) {
    if (error instanceof ORPCError) return { ran: false, reason: error.message }
    return { ran: false, reason: 'the monica desktop is not running' }
  }
}

function isRequest(message: unknown): message is RunButtonRequest {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  if (message.type === 'monica.runButtons') {
    return 'refs' in message && Array.isArray(message.refs)
  }
  if (message.type === 'monica.runFromButton') {
    return 'ref' in message && typeof message.ref === 'string'
  }
  return false
}
