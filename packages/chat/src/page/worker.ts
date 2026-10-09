declare const self: Worker

/** 本文にする Worker の返事。 */
export type WorkerReply = { text: string } | { error: string }

// 普通のページは 0.1 秒かからずに本文になる。それより桁違いに長いページは、本文を諦めて質問に答える。
const READ_TIMEOUT_MS = 30_000

/**
 * Worker を 1 つ起こして request を渡し、返事の本文を返す。Backend の event loop を塞がないよう、本文にするのは Worker の thread で行う。
 * 返事を受けるか、30 秒を過ぎるか、signal が abort したら、Worker の返事を待たずに terminate する。
 */
export function textInWorker(
  module: URL,
  request: unknown,
  {
    transfer = [],
    signal,
    timedOut,
  }: { transfer?: Transferable[]; signal?: AbortSignal; timedOut: string },
): Promise<string> {
  signal?.throwIfAborted()
  const worker = new Worker(module)
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      worker.terminate()
      finish()
    }
    const aborted = () => settle(() => reject(signal?.reason))
    const timer = setTimeout(() => settle(() => reject(new Error(timedOut))), READ_TIMEOUT_MS)
    signal?.addEventListener('abort', aborted)
    worker.addEventListener('message', ({ data }: MessageEvent<WorkerReply>) =>
      settle(() => ('error' in data ? reject(new Error(data.error)) : resolve(data.text))),
    )
    worker.addEventListener('error', (event) => settle(() => reject(new Error(event.message))))
    worker.postMessage(request, transfer)
  })
}

/** Worker の module で、届いた request を本文にして返す listener を置く。top-level の await より前に呼ぶ。後に置くと最初の message を取りこぼす。 */
export function replyWithText(textOf: (request: never) => Promise<string>): void {
  self.addEventListener('message', async ({ data }: MessageEvent<unknown>) => {
    let reply: WorkerReply
    try {
      reply = { text: await textOf(data as never) }
    } catch (error) {
      reply = { error: (error as Error).message }
    }
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker の postMessage は targetOrigin を取らない。
    self.postMessage(reply)
  })
}
