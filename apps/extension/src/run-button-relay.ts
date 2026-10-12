import { viaNativeHost } from '@monica/chat/native-host'
import type {
  contract as taskContract,
  Pressable,
  RunButtonRow,
  RunButtonsOutput,
} from '@monica/task/contract'
import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'

/** content script が service worker に送る message。content script は Native Messaging を呼べないため。 */
export type RunButtonRequest =
  | { type: 'monica.runButtons'; refs: string[] }
  | { type: 'monica.press'; ref: string; run: Pressable }

/** null なら Backend に届かなかった。 */
export type RunButtonsReply = RunButtonsOutput | null

/** 押下の後に出す行か、Backend に届かなかったか error が返った理由。 */
export type PressReply = { row: RunButtonRow } | { failed: string }

type Client = ContractRouterClient<{ task: Pick<typeof taskContract, 'runButtons' | 'press'> }>

const PRESSABLE: unknown[] = ['new', 'resume', 'reopen'] satisfies Pressable[]

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
    case 'monica.press':
      return press(client, message.ref, message.run)
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

async function press(client: Client, ref: string, run: Pressable): Promise<PressReply> {
  try {
    return { row: await client.task.press({ ref, run }) }
  } catch (error) {
    if (error instanceof ORPCError) return { failed: error.message }
    return { failed: 'the monica desktop is not running' }
  }
}

function isRequest(message: unknown): message is RunButtonRequest {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  if (message.type === 'monica.runButtons') {
    return 'refs' in message && Array.isArray(message.refs)
  }
  if (message.type === 'monica.press') {
    return (
      'ref' in message &&
      typeof message.ref === 'string' &&
      'run' in message &&
      PRESSABLE.includes(message.run)
    )
  }
  return false
}
