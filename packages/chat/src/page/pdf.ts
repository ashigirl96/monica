import { textInWorker } from './worker.ts'

export type PdfRequest = { bytes: ArrayBuffer; cMaps: string; maxChars: number }

/** PDF の bytes を Worker の pdf.js で本文にする。maxChars を超えたら残りのページは読まない。 */
export async function pdfText(
  pdf: Blob,
  { worker, cMaps }: { worker: URL; cMaps: string },
  { maxChars, signal }: { maxChars: number; signal?: AbortSignal },
): Promise<string> {
  const bytes = await pdf.arrayBuffer()
  const request: PdfRequest = { bytes, cMaps, maxChars }
  // 大きな PDF の bytes を Backend の側に残さない。
  return textInWorker(worker, request, {
    transfer: [bytes],
    signal,
    timedOut: 'reading the PDF took more than 30 seconds',
  })
}
