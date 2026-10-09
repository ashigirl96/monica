import type { Page } from '../contract.ts'
import type { CurrentPageWatch } from './current-page.ts'
import { readPage } from './read-page.ts'
import { takeScreenshot } from './screenshot.ts'

/**
 * 送る時に side panel の window の Current Page を読み、screenshot なら表示領域も撮る。
 * 撮るのは最初の await より前にし、executeScript と並べて待つ。executeScript の 3 秒を待ってから撮ると、user gesture の窓（約 5 秒）を食う。
 * 撮れなくても、読めなくても、もう一方は添える。
 */
export async function readCurrentPage(
  watch: CurrentPageWatch,
  { screenshot }: { screenshot: boolean },
): Promise<Page> {
  const taking = screenshot ? takeScreenshot(watch.windowId()) : undefined
  const [page, taken] = await Promise.all([watch.read().then(readPage), taking])
  return { ...page, ...taken }
}
