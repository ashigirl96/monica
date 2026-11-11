import './globals.css'
import type { contract as noteContract } from '@monica/note/contract'
import {
  type CallContext,
  NotesApp,
  navigate,
  noteLinkOptions,
  spaLinkClick,
} from '@monica/note/ui'
import type { contract as studyContract } from '@monica/study/contract'
import { createStudySlots } from '@monica/study/ui'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

type Client = ContractRouterClient<
  { note: typeof noteContract; study: typeof studyContract },
  CallContext
>

// ブラウザの口は token を持たず、Host と Sec-Fetch-Site で守る。
const client: Client = createORPCClient(
  new RPCLink({ url: `${location.origin}/rpc`, ...noteLinkOptions }),
)

const studySlots = createStudySlots({
  client: client.study,
  repoCandidates: () => client.note.repo.candidates(),
  navigate,
  spaLinkClick,
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NotesApp client={client.note} {...studySlots} />
  </StrictMode>,
)
