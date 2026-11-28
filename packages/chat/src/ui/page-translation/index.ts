import type { Segment } from '../../contract.ts'
import type { PageTranslationMessage } from './relay.ts'
import { createPageTranslator, type PageTranslator, type SegmentsReply } from './translator.ts'

const TRANSLATOR = Symbol.for('monica.pageTranslator')

const world = globalThis as { [TRANSLATOR]?: PageTranslator }

// 拡張を読み込み直した後も、前に注入した script は Browser Tab に残り、その sendMessage は
// Promise を返さずにその場で "Extension context invalidated" を投げる。届かなくてよい知らせなので握りつぶす。
function tell(message: PageTranslationMessage): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => {})
  } catch {}
}

async function translate(segments: Segment[]): Promise<SegmentsReply> {
  // service worker が落ちて答えなかったときは undefined が届く。
  return (
    (await chrome.runtime.sendMessage<PageTranslationMessage, SegmentsReply | undefined>({
      type: 'monica.translateSegments',
      segments,
    })) ?? { failed: 'the Chrome Extension did not answer' }
  )
}

/** 拡張の isolated world は同じ document の間残るので、2 回目からは同じ translator を使う。 */
function pageTranslator(): PageTranslator {
  if (world[TRANSLATOR]) return world[TRANSLATOR]
  const translator = createPageTranslator({
    document,
    url: () => location.href,
    translate,
    report: (state) => tell({ type: 'monica.pageTranslationState', state }),
  })
  // 戻る・進むで戻った document は、離れている間に別の document で ⌥A を押した結果に合わせる。
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) void followSwitch()
  })
  return (world[TRANSLATOR] = translator)
}

function turn(on: boolean): void {
  const translator = pageTranslator()
  if (translator.active !== on) translator.toggle()
}

async function followSwitch(): Promise<void> {
  let on: boolean | undefined
  try {
    on = await chrome.runtime.sendMessage<PageTranslationMessage, boolean | undefined>({
      type: 'monica.pageTranslationWanted',
    })
  } catch {
    return
  }
  if (on === undefined) return
  const translator = pageTranslator()
  // 戻る・進むのために残された間、送っていた塊の答えは成功も失敗も返らない。
  if (on && translator.active) translator.restart()
  else turn(on)
}

export function togglePageTranslation(): void {
  const on = !pageTranslator().active
  turn(on)
  tell({ type: 'monica.pageTranslationSwitched', on })
}

/** 先読みで開いた document は、表に出てから訳し始める。見られないかもしれないページを訳しに送らないため。 */
export function resumePageTranslation(): void {
  if ((document as { prerendering?: boolean }).prerendering) {
    document.addEventListener('prerenderingchange', () => turn(true), { once: true })
  } else turn(true)
}
