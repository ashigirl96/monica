import type { RPCLinkOptions } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { createContext, useContext } from 'react'

import type { contract } from '../contract.ts'
import { Reach } from './reach.ts'

export type CallContext = { keepalive?: boolean }
export type NoteClient = ContractRouterClient<typeof contract, CallContext>

export const reach = new Reach()

export function linkOptions(
  observer: Pick<Reach, 'reached' | 'failed'>,
): Omit<RPCLinkOptions<CallContext>, 'url'> {
  return {
    // pagehide の保存は、タブが閉じた後も送り切るよう keepalive で出す。
    fetch: (request, init, { context }) =>
      fetch(request, { ...init, keepalive: context.keepalive }),
    adapterInterceptors: [
      async (options) => {
        try {
          const response = await options.next()
          observer.reached()
          return response
        } catch (error) {
          if (!(error instanceof DOMException && error.name === 'AbortError')) observer.failed()
          throw error
        }
      },
    ],
  }
}

export const noteLinkOptions = linkOptions(reach)

export const ClientContext = createContext<NoteClient | null>(null)

export function useNoteClient(): NoteClient {
  const client = useContext(ClientContext)
  if (client === null) throw new Error('useNoteClient requires the client of NotesApp')
  return client
}
