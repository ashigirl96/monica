import './globals.css'
import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import type { contract as noteContract } from '@tania/note/contract'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

type Client = ContractRouterClient<{ note: typeof noteContract }>

// notes の口は token を持たず、Host と Sec-Fetch-Site で守る（ADR-0017）。
const client: Client = createORPCClient(new RPCLink({ url: `${location.origin}/rpc` }))

function Placeholder() {
  const [reach, setReach] = useState('Backend を確かめています…')
  useEffect(() => {
    // 無い Note の NOT_FOUND も、notes の口の procedure が答えた証になる。
    client.note.get({ id: 'note-1' }).then(
      () => setReach('Backend の notes の口に届いた'),
      (error: unknown) =>
        setReach(
          error instanceof ORPCError && error.code === 'NOT_FOUND'
            ? 'Backend の notes の口に届いた'
            : `Backend に届かない: ${(error as Error).message}`,
        ),
    )
  }, [])
  return (
    <main className="flex h-full flex-col items-center justify-center gap-2">
      <h1 className="text-2xl font-semibold">tania notes</h1>
      <p className="text-muted-foreground">{reach}</p>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
)
