import { dirname, join } from 'node:path'

/** PDF を本文にする Worker の module と、pdf.js の cMap の folder。 */
export type PdfReader = { worker: URL; cMaps: string }

export type PdfRequest = { bytes: ArrayBuffer; cMaps: string; maxChars: number }
export type PdfReply = { text: string } | { error: string }

const READ_TIMEOUT_MS = 30_000

/**
 * packages/chat の中の Worker と、node_modules の pdfjs-dist の cMap。compile した Backend はどちらも解けないので、同梱したものを渡す。
 * bun の isolated linker では pdfjs-dist を packages/chat からしか解けない。
 */
export function bundledPdfReader(given: Partial<PdfReader> = {}): PdfReader {
  return {
    worker: given.worker ?? new URL('../pdf-worker.ts', import.meta.url),
    cMaps:
      given.cMaps ??
      join(dirname(Bun.resolveSync('pdfjs-dist/package.json', import.meta.dir)), 'cmaps'),
  }
}

/**
 * PDF の bytes を Worker の pdf.js で本文にする。Backend の event loop を塞がないよう、PDF 1 つごとに Worker を起こして終える。
 * maxChars を超えたら残りのページは読まない。30 秒で打ち切る。
 */
export async function pdfText(
  pdf: Blob,
  reader: PdfReader,
  { maxChars, signal }: { maxChars: number; signal?: AbortSignal },
): Promise<string> {
  const bytes = await pdf.arrayBuffer()
  signal?.throwIfAborted()
  const worker = new Worker(reader.worker)
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      worker.terminate()
      finish()
    }
    const aborted = () => settle(() => reject(signal?.reason))
    const timer = setTimeout(
      () => settle(() => reject(new Error('reading the PDF took more than 30 seconds'))),
      READ_TIMEOUT_MS,
    )
    signal?.addEventListener('abort', aborted)
    worker.addEventListener('message', ({ data }: MessageEvent<PdfReply>) =>
      settle(() => ('error' in data ? reject(new Error(data.error)) : resolve(data.text))),
    )
    worker.addEventListener('error', (event) => settle(() => reject(new Error(event.message))))
    const request: PdfRequest = { bytes, cMaps: reader.cMaps, maxChars }
    // 大きな PDF の bytes を Backend の側に残さない。
    worker.postMessage(request, [bytes])
  })
}
