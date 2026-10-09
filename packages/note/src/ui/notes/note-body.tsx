import { useEffect, useMemo } from 'react'

import { toMarkdown } from '../../body/index.ts'
import type { Doc } from '../../contract.ts'
import { docFromJSON, type DocRead } from '../editor/create-editor.ts'

const reads = new WeakMap<Doc, DocRead>()

// 保存の予約は打鍵のたびに読むので、同じ本文は 1 度だけ読む。
export function readBody(content: Doc): DocRead {
  const cached = reads.get(content)
  if (cached !== undefined) return cached
  const read = docFromJSON(content)
  reads.set(content, read)
  return read
}

export function UnreadableNotice({ error }: { error: string }) {
  return (
    <p role="alert" className="mt-2 text-xs text-destructive">
      この本文はエディタで開けません
      <span className="ml-2 font-mono text-[0.7rem] opacity-70">{error}</span>
    </p>
  )
}

export function UnreadableBody({
  noteId,
  content,
  error,
}: {
  noteId: string
  content: Doc
  error: string
}) {
  const markdown = useMemo(() => toMarkdown(content), [content])
  useEffect(() => {
    console.error(`note ${noteId} の本文をエディタで開けません: ${error}`)
  }, [noteId, error])
  return (
    <pre className="min-h-[70dvh] pt-4 pb-[40dvh] font-mono text-sm break-words whitespace-pre-wrap text-[var(--ink-text)] select-text">
      {markdown}
    </pre>
  )
}
