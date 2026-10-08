import './globals.css'
import type { contract as chatContract } from '@monica/chat/contract'
import { ChatApp } from '@monica/chat/ui'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

type Client = ContractRouterClient<{ chat: typeof chatContract }>

// ブラウザの口は token を持たず、Chrome Extension の fetch が付ける Sec-Fetch-Site: none で通る（ADR-0028）。
const client: Client = createORPCClient(
  new RPCLink({ url: `http://127.0.0.1:${__MONICA_BROWSER_PORT__}/rpc` }),
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChatApp client={client.chat} />
  </StrictMode>,
)
