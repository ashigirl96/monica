import type { LeftOut, PageSnapshot, SentTurn, Unreadable } from '../contract.ts'
import { withinPromptLimit } from '../history.ts'
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

type PageLeftOut = Extract<LeftOut, { kind: 'page' }>

function leftOutNote({ parts }: PageLeftOut): string[] {
  return [
    `The ${parts.join(' and ')} of the page ${parts.length > 1 ? 'are' : 'is'} left out to keep this message within its length limit.`,
  ]
}

function heading(
  n: number,
  question: string,
  page: PageSnapshot,
  pageLeftOut: PageLeftOut | undefined,
): string {
  return [
    `Question ${n}, asked on this page:`,
    `URL: ${page.url ?? 'unknown'}`,
    `Title: ${page.title ?? 'unknown'}`,
    ...(pageLeftOut
      ? leftOutNote(pageLeftOut)
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
  pageLeftOut: PageLeftOut | undefined,
): Block[] {
  const { content, selection, screenshot, title, url } = page
  if (pageLeftOut) return [{ type: 'text', text: heading(n, question, page, pageLeftOut) }]
  return [
    ...(hasText(content) ? [document(content, title, url)] : []),
    ...(screenshot === undefined ? [] : [image(screenshot)]),
    ...(selection ? [document(selection, title ? `Selection: ${title}` : 'Selection', url)] : []),
    { type: 'text', text: heading(n, question, page, undefined) },
  ]
}

const answerBlock = (n: number, answer: string): Block => ({
  type: 'text',
  text: `Your answer to question ${n}:\n<answer>\n${answer}\n</answer>`,
})

const bounded = (page: PageSnapshot): PageSnapshot => ({
  ...page,
  ...(page.url !== undefined && { url: cut(page.url, MAX_URL_CHARS).text }),
  ...(page.title !== undefined && {
    title: cut(page.title, MAX_TITLE_CHARS).text,
  }),
})

/**
 * 前の問答と今の質問を、古い順に turn ごとに本文の document、スクリーンショットの image、選択範囲の document、見出しと質問の text、答えの text の順に並べる。
 * 今の turn は答えの手前で終えるので、何も落とさなければ n 問目の並びは n+1 問目の並びの頭と一致する。
 */
export function askContent(
  question: string,
  current: PageSnapshot,
  sent: readonly SentTurn[],
): { content: Block[]; omitted: { pages: number; turns: number } } {
  const page = bounded(current)
  const { history, omitted } = withinPromptLimit(
    question,
    page,
    sent.map((turn) => ({ ...turn, page: bounded(turn.page) })),
  )
  const opening: Block[] =
    omitted.turns > 0
      ? [
          {
            type: 'text',
            text: `${omitted.turns} earlier ${omitted.turns > 1 ? 'questions of this chat and their answers are' : 'question of this chat and its answer is'} left out to keep this message within its length limit.`,
          },
        ]
      : []
  const earlier = history.flatMap((turn, i) =>
    turn.leftOut?.kind === 'turn'
      ? []
      : [
          ...turnBlocks(i + 1, turn.question, turn.page, turn.leftOut),
          answerBlock(i + 1, turn.answer),
        ],
  )
  return {
    content: [...opening, ...earlier, ...turnBlocks(history.length + 1, question, page, undefined)],
    omitted,
  }
}
