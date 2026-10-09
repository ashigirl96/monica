import type { Reading, ReadOptions } from './chat-store.ts'
import type { CurrentPageWatch } from './current-page.ts'
import { readPage } from './read-page.ts'
import { takeScreenshot } from './screenshot.ts'

/**
 * 送る時に side panel の window の Current Page を読み、screenshot なら表示領域も撮る。
 * 撮るのは最初の await より前にし、executeScript と並べて待つ。executeScript の 3 秒を待ってから撮ると、user gesture の窓（約 5 秒）を食う。
 * 撮れなくても、読めなくても、もう一方は添える。
 */
export function readCurrentPage(
  watch: CurrentPageWatch,
  { screenshot, maxPdfBytes, signal }: ReadOptions,
): Reading {
  const taking = screenshot ? takeScreenshot(watch.windowId()) : undefined
  const reading = watch.read().then((tab) => readPage(tab, { maxPdfBytes, signal }))
  return {
    shown: watch.shown(),
    page: Promise.all([reading, taking]).then(([page, taken]) => ({ ...page, ...taken })),
  }
}
