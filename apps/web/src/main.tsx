import './globals.css'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import type { contract as noteContract } from '@tania/note/contract'
import { type CallContext, NotesApp, noteLinkOptions } from '@tania/note/ui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

type Client = ContractRouterClient<{ note: typeof noteContract }, CallContext>

// notes の口は token を持たず、Host と Sec-Fetch-Site で守る（ADR-0017）。
const client: Client = createORPCClient(
  new RPCLink({ url: `${location.origin}/rpc`, ...noteLinkOptions }),
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NotesApp client={client.note} />
  </StrictMode>,
)
