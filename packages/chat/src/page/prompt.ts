import type { PageSnapshot, Turn, Unreadable } from '../contract.ts'
import type { Block } from '../prompt.ts'
import { cut, MAX_PAGE_CHARS } from './snapshot.ts'

// API は document の title を 1〜500 字、context を 1 字以上とする。
const MAX_TITLE_CHARS = 500
// ページは pushState と document.title で URL と title を好きな長さにできる。
const MAX_URL_CHARS = 2_000
const PAGE_LIMIT = `${MAX_PAGE_CHARS.toLocaleString('en')} characters`

function document(
  { text, truncated, source }: { text: string; truncated: boolean; source?: 'html' | 'pdf' },
  title: string | undefined,
  url: string | undefined,
): Block {
  return {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: text },
    ...(title && { title }),
    context: [
      `URL: ${url ?? 'unknown'}`,
      // PDF の本文は見出しや段落の構造を持たない。
      ...(source === 'pdf' ? ['Text extracted from a PDF, without its layout.'] : []),
      ...(truncated ? [`Only the first ${PAGE_LIMIT} of it.`] : []),
    ].join('\n'),
  }
}

const image = (data: string): Block => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/jpeg', data },
})

const UNREADABLE: Record<Unreadable['reason'], string> = {
  restricted: 'the browser does not let extensions read this page',
  timeout: 'the page did not respond within 3 seconds',
  'too-large': 'the page was too large to send',
  'fetch-failed': 'its PDF could not be fetched',
  unparsable: 'its HTML or PDF could not be turned into text',
}

type PageText = Extract<NonNullable<PageSnapshot['content']>, { kind: 'text' }>

const hasText = (content: PageSnapshot['content']): content is PageText =>
  content?.kind === 'text' && content.text !== ''

function contentNote({ content }: PageSnapshot): string[] {
  switch (content?.kind) {
    case undefined:
      return []
    case 'text':
      if (content.text === '') return ['The page had no text.']
      return [
        `The text of the page is the document above${content.truncated ? `, cut to its first ${PAGE_LIMIT}` : ''}.`,
      ]
    case 'same':
      return [
        `The page has the same text as on the page of question ${content.turn + 1}, so it is not repeated.`,
      ]
    case 'unreadable':
      return [
        `The page could not be read: ${UNREADABLE[content.reason]}${content.detail ? ` (${content.detail})` : ''}.`,
      ]
  }
}

function selectionNote({ selection }: PageSnapshot): string[] {
  if (!selection) return []
  return [
    `The user selected part of the page; it is the document titled "Selection" above${selection.truncated ? `, cut to its first ${PAGE_LIMIT}` : ''}.`,
  ]
}

function screenshotNote({ screenshot, screenshotFailed }: PageSnapshot): string[] {
  if (screenshotFailed) {
    return [
      `A screenshot of the page was asked for but could not be taken: ${screenshotFailed.reason}.`,
    ]
  }
  if (screenshot === undefined) return []
  return [
    'The user attached a screenshot of the visible part of the page, taken when the question was sent; it is the image above.',
  ]
}

function leftOutNote(page: PageSnapshot): string[] {
  const parts = [
    ...(hasText(page.content) ? ['text'] : []),
    ...(page.screenshot === undefined ? [] : ['screenshot']),
    ...(page.selection ? ['selection'] : []),
  ]
  return [
    `The ${parts.join(' and ')} of the page ${parts.length > 1 ? 'are' : 'is'} left out to keep this message within its length limit.`,
  ]
}

function heading(n: number, question: string, page: PageSnapshot, pageLeftOut: boolean): string {
  return [
    `Question ${n}, asked on this page:`,
    `URL: ${page.url ?? 'unknown'}`,
    `Title: ${page.title ?? 'unknown'}`,
    ...(pageLeftOut
      ? leftOutNote(page)
      : [...contentNote(page), ...screenshotNote(page), ...selectionNote(page)]),
    '',
    `<question>\n${question}\n</question>`,
  ].join('\n')
}

// 選択範囲もページの作者が書いた文字なので、質問の text に混ぜない。
function turnBlocks(
  n: number,
  question: string,
  page: PageSnapshot,
  pageLeftOut: boolean,
): Block[] {
  const { content, selection, screenshot, title, url } = page
  if (pageLeftOut) return [{ type: 'text', text: heading(n, question, page, true) }]
  return [
    ...(hasText(content) ? [document(content, title, url)] : []),
    ...(screenshot === undefined ? [] : [image(screenshot)]),
    ...(selection ? [document(selection, title ? `Selection: ${title}` : 'Selection', url)] : []),
    { type: 'text', text: heading(n, question, page, false) },
  ]
}

const answerBlock = (n: number, answer: string): Block => ({
  type: 'text',
  text: `Your answer to question ${n}:\n<answer>\n${answer}\n</answer>`,
})

/** 1 回に送る前の問答・前のページ・今の Page Snapshot の字の和の上限。見出しの決まった文は数えない。 */
export const MAX_ASK_CHARS = 200_000
/** スクリーンショット 1 枚を数える字数。CSS px の 1280×800 の JPEG が約 1,300 token になる。 */
const SCREENSHOT_CHARS = 1_500

const bounded = (page: PageSnapshot): PageSnapshot => ({
  ...page,
  ...(page.url !== undefined && { url: cut(page.url, MAX_URL_CHARS).text }),
  ...(page.title !== undefined && { title: cut(page.title, MAX_TITLE_CHARS).text }),
})

// ページを落としても見出しに残るので、turn の問答の側に数える。
const addressChars = ({ url, title }: PageSnapshot) => (url?.length ?? 0) + (title?.length ?? 0)

const words = (turn: Turn) => turn.question.length + turn.answer.length + addressChars(turn.page)

function pageChars({ content, selection, screenshot }: PageSnapshot): number {
  return (
    (content?.kind === 'text' ? content.text.length : 0) +
    (selection?.text.length ?? 0) +
    (screenshot === undefined ? 0 : SCREENSHOT_CHARS)
  )
}

// 古い turn のページから 1 つずつ落とし、それでも超えたら古い turn の問答を落とす。
// 今の分と、Current Page の Page Snapshot が same で指す turn は落とさない。Current Page の本文がそこにしか無いため。
function leaveOut(question: string, page: PageSnapshot, history: readonly Turn[]) {
  const kept = page.content?.kind === 'same' ? page.content.turn : undefined
  let total =
    question.length +
    addressChars(page) +
    pageChars(page) +
    history.reduce((sum, turn) => sum + words(turn) + pageChars(turn.page), 0)
  const pages = new Set<number>()
  const turns = new Set<number>()
  history.forEach((turn, i) => {
    const size = pageChars(turn.page)
    if (total <= MAX_ASK_CHARS || i === kept || size === 0) return
    pages.add(i)
    total -= size
  })
  history.forEach((turn, i) => {
    if (total <= MAX_ASK_CHARS || i === kept) return
    turns.add(i)
    // 問答ごと落とした turn のページは、問答の数に含めて 2 度数えない。
    pages.delete(i)
    total -= words(turn)
  })
  return { pages, turns }
}

/**
 * 前の問答と今の質問を、古い順に turn ごとに本文の document、スクリーンショットの image、選択範囲の document、見出しと質問の text、答えの text の順に並べる。
 * 今の turn は答えの手前で終えるので、何も落とさなければ n 問目の並びは n+1 問目の並びの頭と一致する。
 */
export function askContent(
  question: string,
  current: PageSnapshot,
  sent: readonly Turn[],
): { content: Block[]; omitted: { pages: number; turns: number } } {
  const page = bounded(current)
  const history = sent.map((turn) => ({ ...turn, page: bounded(turn.page) }))
  const { pages, turns } = leaveOut(question, page, history)
  const opening: Block[] =
    turns.size > 0
      ? [
          {
            type: 'text',
            text: `${turns.size} earlier ${turns.size > 1 ? 'questions of this chat and their answers are' : 'question of this chat and its answer is'} left out to keep this message within its length limit.`,
          },
        ]
      : []
  const earlier = history.flatMap((turn, i) =>
    turns.has(i)
      ? []
      : [
          ...turnBlocks(i + 1, turn.question, turn.page, pages.has(i)),
          answerBlock(i + 1, turn.answer),
        ],
  )
  return {
    content: [...opening, ...earlier, ...turnBlocks(history.length + 1, question, page, false)],
    omitted: { pages: pages.size, turns: turns.size },
  }
}
