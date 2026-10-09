import { textInWorker } from './worker.ts'

export type HtmlRequest = { html: string; url: string | undefined }

/** getHTML が書き出した HTML を、Worker の defuddle で本文にする。div を 3,000 段入れ子にしたページは数十秒かかる。 */
export function htmlText(
  html: string,
  url: string | undefined,
  worker: URL,
  { signal }: { signal?: AbortSignal },
): Promise<string> {
  const request: HtmlRequest = { html, url }
  return textInWorker(worker, request, {
    signal,
    timedOut: 'turning the HTML into text took more than 30 seconds',
  })
}
