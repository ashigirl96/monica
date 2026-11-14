import {
  type AskInput,
  type LeftOut,
  MAX_ASK_BODY_BYTES,
  type Page,
  type PageSnapshot,
  type SentTurn,
  type SnapshotEvent,
  type Turn,
  type Unreadable,
} from './contract.ts'

/** 1 回に送る前の問答・前のページ・今の Page Snapshot の字の和の上限。見出しの決まった文は数えない。 */
const MAX_ASK_CHARS = 200_000
/** スクリーンショット 1 枚を数える字数。CSS px の 1280×800 の JPEG が約 1,300 token になる。 */
const SCREENSHOT_CHARS = 1_500
// oRPC が input を包む分の余白。
const BODY_MARGIN_BYTES = 1024 * 1024

// Backend は質問と答えの文字をそのまま prompt にするので、印も文字のまま claude に渡る。
const LEFT_OUT_MARK = '（大きすぎて送れなかった）'
const TOO_LARGE: Unreadable = { kind: 'unreadable', reason: 'too-large' }

type Part = Extract<LeftOut, { kind: 'page' }>['parts'][number]
type Size = (turn: SentTurn) => number

// File は JSON.stringify で {} になり、multipart の別の part で送られる。
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

const bodyBytes = (input: AskInput) =>
  jsonBytes(input) + (input.page.content.kind === 'pdf' ? input.page.content.pdf.size : 0)

const overLimit = (input: AskInput) => bodyBytes(input) + BODY_MARGIN_BYTES - MAX_ASK_BODY_BYTES

/** 外せば無くなるもの。same のページは、指す先の本文を text として持つ。 */
function partsOf(turn: SentTurn): Part[] {
  if (turn.leftOut) return []
  const { content, screenshot, selection } = turn.page
  return [
    ...((content?.kind === 'text' && content.text !== '') || content?.kind === 'same'
      ? (['text'] as const)
      : []),
    ...(screenshot === undefined ? [] : (['screenshot'] as const)),
    ...(selection ? (['selection'] as const) : []),
  ]
}

const sameTarget = (turn: SentTurn) =>
  !turn.leftOut && turn.page.content?.kind === 'same' ? turn.page.content.turn : undefined

/** ページの本文・選択範囲・スクリーンショットを外した turn。外すものが無ければ受けた turn のまま。 */
function withPageLeftOut(turn: SentTurn): SentTurn {
  const parts = partsOf(turn)
  if (parts.length === 0) return turn
  const { selection: _selection, screenshot: _screenshot, ...rest } = turn.page
  const page = parts.includes('text') ? { ...rest, content: TOO_LARGE } : rest
  return { ...turn, page, leftOut: { kind: 'page', parts } }
}

const withTurnLeftOut = (turn: SentTurn): SentTurn => ({
  question: LEFT_OUT_MARK,
  answer: LEFT_OUT_MARK,
  page: withPageLeftOut(turn).page,
  leftOut: { kind: 'turn' },
})

/**
 * 外すページの添字を、外す順に並べる。
 * ページの本文は、それを same で指す最も新しい turn まで要るので、その位置の古い順に外す。同じ位置では指す側を先に外す。
 * same が指す先だけが外れて、指す側が残ることはない。kept（Current Page が same で指す turn）は外さない。
 */
function pageOrder(history: readonly SentTurn[], kept: number | undefined): number[] {
  const lastNeeded = history.map((_, i) => i)
  history.forEach((turn, i) => {
    const j = sameTarget(turn)
    if (j !== undefined && j < i) lastNeeded[j] = Math.max(lastNeeded[j]!, i)
  })
  return [...history.keys()]
    .filter((i) => i !== kept && partsOf(history[i]!).length > 0)
    .toSorted((a, b) => lastNeeded[a]! - lastNeeded[b]! || b - a)
}

/**
 * over が 0 以下になるまで pageOrder の順にページを外し、turns なら古い順に問答ごと外す。
 * 問答を外すのはページを外し切った後なので、外した turn を same で指すページは残らない。
 * 長さと添字は変えない。same が添字で前の turn を指すため。
 */
function leaveOut(
  history: readonly SentTurn[],
  { over, size, kept, turns }: { over: number; size: Size; kept?: number; turns: boolean },
): { history: SentTurn[]; over: number } {
  const sent = [...history]
  const replace = (i: number, next: SentTurn) => {
    over -= size(sent[i]!) - size(next)
    sent[i] = next
  }
  for (const i of pageOrder(sent, kept)) {
    if (over <= 0) break
    replace(i, withPageLeftOut(sent[i]!))
  }
  for (const i of turns ? sent.keys() : []) {
    if (over <= 0) break
    if (i === kept || sent[i]!.leftOut?.kind === 'turn') continue
    replace(i, withTurnLeftOut(sent[i]!))
  }
  return { history: sent, over }
}

function tooLarge({ url, title, screenshot, screenshotFailed }: Page): Page {
  return {
    ...(url !== undefined && { url }),
    ...(title !== undefined && { title }),
    content: TOO_LARGE,
    ...(screenshot !== undefined && { screenshot }),
    ...(screenshotFailed && { screenshotFailed }),
  }
}

/**
 * body の上限を超える input は、前のページから外していく。
 * 前のページを全部外しても超えるなら、Current Page の HTML・PDF・選択範囲を外して大きすぎて読めなかったことにし、
 * 前のページを外し直したうえで、古い問答も外す。ユーザーが添えると決めた Current Page のスクリーンショットは残す。
 */
export function withinBodyLimit(input: AskInput): AskInput {
  if (overLimit(input) <= 0) return input
  const pagesOut = leaveOut(input.history, {
    over: overLimit(input),
    size: jsonBytes,
    turns: false,
  })
  if (pagesOut.over <= 0) return { ...input, history: pagesOut.history }
  const page = tooLarge(input.page)
  const { history } = leaveOut(input.history, {
    over: overLimit({ ...input, page }),
    size: jsonBytes,
    turns: true,
  })
  return { ...input, page, history }
}

/**
 * Current Page の PDF に残る bytes。body の上限から、前のページを外した PDF の他の input と余白を引く。
 * Current Page のスクリーンショットは読むのと並べて撮るので数えず、送る前の withinBodyLimit が数える。
 */
export function pdfRoom(question: string, history: readonly Turn[]): number {
  const bare = history.map(withPageLeftOut)
  return MAX_ASK_BODY_BYTES - BODY_MARGIN_BYTES - jsonBytes({ question, history: bare })
}

function pageChars({ content, selection, screenshot }: PageSnapshot): number {
  return (
    (content?.kind === 'text' ? content.text.length : 0) +
    (selection?.text.length ?? 0) +
    (screenshot === undefined ? 0 : SCREENSHOT_CHARS)
  )
}

// ページを外しても見出しに残るので、URL と title は問答の側に数える。
const addressChars = ({ url, title }: PageSnapshot) => (url?.length ?? 0) + (title?.length ?? 0)

const turnChars = (turn: SentTurn) =>
  turn.leftOut?.kind === 'turn'
    ? 0
    : turn.question.length + turn.answer.length + addressChars(turn.page) + pageChars(turn.page)

// 指す先の本文が無い same は、指す先を外した side panel から届く。本文の無い参照を prompt に残さない。
function withoutDanglingSame(history: readonly SentTurn[]): SentTurn[] {
  return history.map((turn, i) => {
    const j = sameTarget(turn)
    if (j === undefined) return turn
    const target = history[j]
    const held = j < i && !target?.leftOut && target?.page.content?.kind === 'text'
    return held ? turn : withPageLeftOut(turn)
  })
}

/**
 * prompt の字数の上限に収まるよう、前の turn から外す。今の質問と Current Page は外さない。
 * Current Page が same で指す turn は、ページも問答も外さない。Current Page の本文がそこにしか無いため。
 * omitted は印から数えるので、side panel が外した分も入る。問答ごと外した turn のページは数えない。
 * URL と title は、見出しと同じ字で数えるよう、呼び手が切り詰めてから渡す。
 */
export function withinPromptLimit(
  question: string,
  page: PageSnapshot,
  history: readonly SentTurn[],
): { history: SentTurn[]; omitted: SnapshotEvent['omitted'] } {
  const checked = withoutDanglingSame(history)
  const total =
    question.length +
    addressChars(page) +
    pageChars(page) +
    checked.reduce((sum, turn) => sum + turnChars(turn), 0)
  const kept = page.content?.kind === 'same' ? page.content.turn : undefined
  const fitted = leaveOut(checked, {
    over: total - MAX_ASK_CHARS,
    size: turnChars,
    kept,
    turns: true,
  }).history
  return {
    history: fitted,
    omitted: {
      pages: fitted.filter((turn) => turn.leftOut?.kind === 'page').length,
      turns: fitted.filter((turn) => turn.leftOut?.kind === 'turn').length,
    },
  }
}
