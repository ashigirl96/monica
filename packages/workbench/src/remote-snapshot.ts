const CHUNK_BYTES = 45 * 1024

export function remoteSnapshot(value: unknown): Response {
  let snapshot: Buffer | null = Buffer.from(JSON.stringify(value))
  let offset = 0
  let index = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!snapshot) return
        if (offset === snapshot.length) {
          controller.enqueue(
            Buffer.from(`${JSON.stringify({ version: 1, type: 'end', count: index })}\n`),
          )
          snapshot = null
          controller.close()
          return
        }
        const data = snapshot.subarray(offset, offset + CHUNK_BYTES).toString('base64')
        offset += Math.min(CHUNK_BYTES, snapshot.length - offset)
        controller.enqueue(
          Buffer.from(`${JSON.stringify({ version: 1, type: 'data', index: index++, data })}\n`),
        )
      },
      cancel() {
        snapshot = null
      },
    }),
    { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } },
  )
}
