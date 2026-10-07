import { ORPCError } from '@orpc/client'

import type { NoteClient } from '../client.ts'
import type { NoteMentionInfo, ResolveNoteMention } from '../editor/node-views.ts'
import type { SearchNoteMentions } from '../editor/note-mention-menu.ts'
import type { ResolveBlock } from '../editor/synced-block.ts'
import type { Reach } from '../reach.ts'

export type NoteReferences = {
  searchNoteMentions: SearchNoteMentions
  resolveNoteMention: ResolveNoteMention
  resolveBlock: ResolveBlock
  /** copy は同期で markdown を書くので、解決し終えた表示名だけを返す。 */
  noteName: (noteId: string) => string | null
}

/** Note Mention の表示名は、作り直すまで覚えている。 */
export function noteReferences({
  client,
  reach,
  flush,
}: {
  client: NoteClient
  reach: Pick<Reach, 'onRecover' | 'recoveries'>
  flush: () => Promise<void>
}): NoteReferences {
  const names = new Map<string, Promise<NoteMentionInfo | null>>()
  const resolvedNames = new Map<string, string>()
  return {
    searchNoteMentions: (q) => client.noteMention.search({ q }),
    resolveNoteMention: (id) => {
      let name = names.get(id)
      if (name === undefined) {
        // 届かない間は「Deleted note」にせず、未解決のまま戻るのを待つ。
        name = untilReached(reach, () => client.noteMention.resolve({ id })).catch(notFoundAsNull)
        names.set(id, name)
        void name.then((info) => {
          if (info) resolvedNames.set(id, info.displayName)
        }, ignore)
      }
      return name
    },
    // 別の Note の block は保存済みの本文から取るので、直前の編集を先に保存する。
    resolveBlock: async (noteId, blockId) => {
      await flush()
      return client.block.get({ id: noteId, blockId }).catch(notFoundAsNull)
    },
    noteName: (noteId) => resolvedNames.get(noteId) ?? null,
  }
}

// Backend の答えは ORPCError で届くので、それ以外の失敗は届かなかったとみなし、届くようになってから送り直す。
async function untilReached<T>(
  reach: Pick<Reach, 'onRecover' | 'recoveries'>,
  call: () => Promise<T>,
): Promise<T> {
  for (;;) {
    const recoveries = reach.recoveries()
    try {
      return await call()
    } catch (error) {
      if (error instanceof ORPCError) throw error
      await new Promise<void>((resolve) => {
        const stop = reach.onRecover(() => {
          stop()
          resolve()
        })
        if (reach.recoveries() !== recoveries) {
          stop()
          resolve()
        }
      })
    }
  }
}

// 失敗は resolveNoteMention を待つエディタが受け取るので、ここでは名前を覚えないだけにする。
function ignore(): void {}

function notFoundAsNull(error: unknown): null {
  if (error instanceof ORPCError && error.code === 'NOT_FOUND') return null
  throw error
}
