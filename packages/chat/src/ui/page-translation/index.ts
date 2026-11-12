import type { PageTranslationMessage } from './relay.ts'
import { createPageTranslator, type PageTranslator, type SegmentsReply } from './translator.ts'

const TRANSLATOR = Symbol.for('monica.pageTranslator')

/**
 * ⌥A のたびに Browser Tab へ注入した script が呼ぶ。拡張の isolated world は同じ document の間残るので、
 * 2 回目からは同じ translator の切り替えになる。
 */
export function togglePageTranslation(): void {
  const world = globalThis as { [TRANSLATOR]?: PageTranslator }
  world[TRANSLATOR] ??= createPageTranslator({
    document,
    url: () => location.href,
    translate: async (segments) =>
      // service worker が落ちて答えなかったときは undefined が届く。
      (await chrome.runtime.sendMessage<PageTranslationMessage, SegmentsReply | undefined>({
        type: 'monica.translateSegments',
        segments,
      })) ?? { failed: 'the Chrome Extension did not answer' },
    report: (state) =>
      void chrome.runtime
        .sendMessage<PageTranslationMessage>({ type: 'monica.pageTranslationState', state })
        .catch(() => {}),
  })
  world[TRANSLATOR].toggle()
}
