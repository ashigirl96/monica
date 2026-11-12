import { MAX_CLAUDES, MAX_SEGMENT_CHARS, MAX_SEGMENTS, type Segment } from '../../contract.ts'
import { bodyBlocks } from './body.ts'
import {
  currentText,
  type Originals,
  parseTranslation,
  restoreOriginals,
  type TranslatedNode,
  type TranslationBlock,
  unchangedSince,
  writeTranslation,
} from './markup.ts'

/** 1 つの塊を訳しに送った答え。busy は Backend の claude に空きが無かった。 */
export type SegmentsReply = { segments: Segment[] } | { busy: true } | { failed: string }

/** Page Translation の今の状態。拡張のアイコンのバッジに出す。 */
export type PageTranslationState =
  | { kind: 'translating' }
  | { kind: 'translated' }
  | { kind: 'original' }
  | { kind: 'failed'; reason: string }

export type PageTranslator = {
  /** 原文なら訳し始め、訳しているか訳したなら原文に戻す。 */
  toggle(): void
}

// Backend の claude は Chat と合わせて数が決まっているので、1 つは Chat に残す。
const MAX_IN_FLIGHT = MAX_CLAUDES - 1
const CHUNK_CHARS = 1000
const BUSY_WAIT_MS = 1000
const SETTLE_MS = 300

type Pending = { block: TranslationBlock; retried: boolean }

// 見えている所、その下、その上の順。
function visibleFirst(document: Document, blocks: Pending[]): Pending[] {
  const height = document.defaultView?.innerHeight ?? 0
  const keyed = blocks.map((pending) => {
    const { top, bottom } = pending.block.element.getBoundingClientRect()
    return { pending, key: bottom < 0 ? height * 10 - bottom : Math.max(top, 0) }
  })
  return keyed.toSorted((a, b) => a.key - b.key).map(({ pending }) => pending)
}

// 1 つの段落が上限より長くても、その段落だけの塊にして送る。
function takeChunk(pending: Pending[]): Pending[] {
  const chunk: Pending[] = []
  let size = 0
  for (let next = pending[0]; next; next = pending[0]) {
    if (chunk.length >= MAX_SEGMENTS) break
    if (chunk.length > 0 && size + next.block.text.length > CHUNK_CHARS) break
    size += next.block.text.length
    chunk.push(next)
    pending.shift()
  }
  return chunk
}

export function createPageTranslator(deps: {
  document: Document
  url: () => string
  translate(segments: Segment[]): Promise<SegmentsReply>
  report(state: PageTranslationState): void
  wait?: (ms: number) => Promise<void>
}): PageTranslator {
  const { document } = deps
  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const originals: Originals = new Map()
  // 訳は原文の文で引く。段落の番号は 1 回の送信の中でだけ使う。
  const cache = new Map<string, string>()
  let written = new WeakMap<Element, string>()
  // 送り直しても印が合わなかった段落。描き直しのたびに送り直さない。
  let givenUp = new WeakMap<Element, string>()
  const queued = new Set<Element>()
  let pending: Pending[] = []
  let inFlight = 0
  let active = false
  let session = 0
  let settling = 0
  let failed = false
  const observer = new document.defaultView!.MutationObserver(() => {
    if (!active) return
    const mine = ++settling
    void wait(SETTLE_MS).then(() => {
      if (active && mine === settling) scan()
    })
  })

  const watch = () =>
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })

  // 自分で書いた変化と、本文を探すために付ける目印で、描き直しの見張りを起こさない。
  function unwatched<T>(touch: () => T): T {
    observer.disconnect()
    try {
      return touch()
    } finally {
      if (active) watch()
    }
  }

  function write(block: TranslationBlock, kids: TranslatedNode[]): boolean {
    if (!unchangedSince(block)) return false
    writeTranslation(block, kids, originals)
    written.set(block.element, currentText(block.element))
    return true
  }

  function scan() {
    const fresh = unwatched(collect)
    if (fresh.length === 0) {
      settle()
      return
    }
    failed = false
    deps.report({ kind: 'translating' })
    pending.push(...visibleFirst(document, fresh))
    pump()
  }

  function collect(): Pending[] {
    const fresh: Pending[] = []
    for (const block of bodyBlocks(document, deps.url())) {
      const { element, text } = block
      if (queued.has(element) || written.get(element) === text || givenUp.get(element) === text) {
        continue
      }
      // Backend の口が断る長さの段落を送ると、同じ塊の段落まで訳せなくなる。
      if (text.length > MAX_SEGMENT_CHARS) continue
      const known = cache.get(block.text)
      if (known === undefined) {
        queued.add(block.element)
        fresh.push({ block, retried: false })
        continue
      }
      const parsed = parseTranslation(known, block.map, { lenient: true })
      if ('kids' in parsed) write(block, parsed.kids)
    }
    return fresh
  }

  function settle() {
    if (active && !failed && inFlight === 0 && pending.length === 0) {
      deps.report({ kind: 'translated' })
    }
  }

  function pump() {
    while (inFlight < MAX_IN_FLIGHT && pending.length > 0) {
      const chunk = takeChunk(pending)
      inFlight++
      const sent = session
      void send(chunk, sent)
        // 書き戻しが投げても、送信中の数と送り待ちの印を残さない。
        .catch((error: unknown) => {
          if (sent !== session) return false
          failed = true
          deps.report({
            kind: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          })
          return false
        })
        .then((stale) => {
          inFlight--
          for (const { block } of chunk)
            if (!pending.some((p) => p.block === block)) queued.delete(block.element)
          // 送っている間に書き換わった段落は、見張りが見ても送り待ちとして飛ばしたので、ここで見直す。
          if (stale && active) scan()
          pump()
          settle()
        })
    }
  }

  /** 送っている間に書き換わって、答えを書けなかった段落があれば true。 */
  async function send(chunk: Pending[], sent: number): Promise<boolean> {
    const reply = await deps
      .translate(chunk.map(({ block }, id) => ({ id, text: block.text })))
      .catch((error: unknown) => ({
        failed: error instanceof Error ? error.message : String(error),
      }))
    if (sent !== session) return false
    if ('busy' in reply) {
      await wait(BUSY_WAIT_MS)
      if (sent === session) pending.unshift(...chunk)
      return false
    }
    if ('failed' in reply) {
      failed = true
      for (const { block } of pending) queued.delete(block.element)
      pending = []
      deps.report({ kind: 'failed', reason: reply.failed })
      return false
    }
    const again: Pending[] = []
    let stale = false
    unwatched(() =>
      chunk.forEach(({ block, retried }, id) => {
        const text = reply.segments.find((segment) => segment.id === id)?.text
        const parsed =
          text === undefined ? undefined : parseTranslation(text, block.map, { lenient: retried })
        if (!parsed || 'error' in parsed) {
          // 印が合わない段落は 1 回だけ送り直し、それでも合わなければ原文のまま残す。
          if (retried) givenUp.set(block.element, block.text)
          else again.push({ block, retried: true })
          return
        }
        cache.set(block.text, text!)
        if (!write(block, parsed.kids)) stale = true
      }),
    )
    pending.unshift(...again)
    return stale
  }

  function start() {
    active = true
    session++
    failed = false
    watch()
    scan()
  }

  function stop() {
    active = false
    session++
    // 見張りを先に止めないと、戻した変化を描き直しと見て訳を付け直す。
    observer.disconnect()
    pending = []
    queued.clear()
    restoreOriginals(originals)
    written = new WeakMap()
    givenUp = new WeakMap()
    deps.report({ kind: 'original' })
  }

  return {
    toggle() {
      if (active) stop()
      else start()
    },
  }
}
