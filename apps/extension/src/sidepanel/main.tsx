import './globals.css'
import type { contract as chatContract } from '@monica/chat/contract'
import { ChatApp, viaNativeHost } from '@monica/chat/ui'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

type Client = ContractRouterClient<{ chat: typeof chatContract }>

// Backend の token の口を、Native Messaging の host が返す Chrome Extension の token で呼ぶ（ADR-0034）。
const client: Client = createORPCClient(new RPCLink(viaNativeHost(__MONICA_NATIVE_HOST__)))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChatApp client={client.chat} />
  </StrictMode>,
)
