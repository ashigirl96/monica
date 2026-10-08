import { expect, test } from 'bun:test'

import fullDoc from './fixtures/full-doc.json'
import unknownNodes from './fixtures/unknown-nodes.json'
import { fromMarkdown, toMarkdown } from './index.ts'

const noteName = (noteId: string) => (noteId === 'note-42' ? 'Target Note' : null)

// 旧 Monica の `to_markdown` が full-doc.json から書き出した markdown。Synced Block は参照のまま。
const FULL_DOC_MD = `plain ***styled***<u> under</u>~~ gone~~\` mono\`[ linked](https://example.com)
[Example](https://example.com/x)**[Marked](https://example.com/y)**[[note-42|Target Note]]

## Heading

- [x] done
- item
1. first

> hidden

> quoted

> [!warning]
> careful

\`\`\`rust
fn main() {}
\`\`\`

---

[Post](https://example.com/post)

![[note-7#^blk-a]]
![[note-7#^blk-b]]

![](/api/assets/abc.png)

| Col A | Col B |
| --- | --- |
| a1 | b1 \\| piped |`

test('every kind of block in the full doc is written as old Monica wrote it', () => {
  expect(toMarkdown(fullDoc, noteName)).toBe(FULL_DOC_MD)
})

const doc = (...contents: unknown[]) => ({
  type: 'doc',
  content: [
    {
      type: 'blockGroup',
      content: contents.map((content) => ({ type: 'blockContainer', content: [content] })),
    },
  ],
})

const readBack = (value: unknown, names?: (noteId: string) => string | null): unknown =>
  fromMarkdown(toMarkdown(value, names))

const text = (value: string, ...marks: unknown[]) =>
  marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value }

test('a mark holding its own closing delimiter reads back as the same mark', () => {
  const marked = doc({
    type: 'paragraph',
    content: [
      text('a*b', { type: 'italic' }),
      text(' '),
      text('*a**', { type: 'bold' }),
      text(' '),
      text('a~b', { type: 'strike' }),
      text(' '),
      text('a</u>b', { type: 'underline' }),
      text(' '),
      text('a`b', { type: 'code' }),
      text(' '),
      text('`a', { type: 'code' }),
      text(' '),
      text(' a ', { type: 'code' }),
      text(' '),
      text('  ', { type: 'code' }),
      text(' '),
      text('a*b', { type: 'italic' }, { type: 'code' }),
      text(' '),
      text('a]b', { type: 'code' }, { type: 'link', attrs: { href: 'https://example.com' } }),
      text(' '),
      text('see [1]', { type: 'link', attrs: { href: 'https://example.com' } }),
      text(' '),
      { type: 'noteMention', attrs: { noteId: 'note-1' } },
    ],
  })

  expect(readBack(marked, () => 'a [b]')).toEqual(marked)
})

const linkParagraph = (value: string, href: string) => ({
  type: 'paragraph',
  content: [text(value, { type: 'link', attrs: { href } })],
})

test('the title of a Link Mention and a Bookmark reads back as the link text', () => {
  const linked = doc(
    {
      type: 'paragraph',
      content: [
        { type: 'linkMention', attrs: { href: 'https://example.com/a', title: 'see [1] *now*' } },
      ],
    },
    { type: 'bookmark', attrs: { href: 'https://example.com/b', title: '[draft] `v2`' } },
  )
  expect(readBack(linked)).toEqual(
    doc(
      linkParagraph('see [1] *now*', 'https://example.com/a'),
      linkParagraph('[draft] `v2`', 'https://example.com/b'),
    ),
  )
})

// 行頭で block の構文になるもの、inline の構文になるもの、backslash。
const SYNTAX_AS_TEXT = [
  '# Heading',
  '- item',
  '* item',
  '+ item',
  '1. first',
  '2) second',
  'a. alpha',
  'iv. roman',
  '1.',
  '> quote',
  '---',
  '***',
  '___',
  '~~~',
  '```',
  '[ ] open',
  '[x] done',
  '[!note]',
  '![[note-1]]',
  '![[note-1#^blk]]',
  '![](https://example.com/a.png)',
  '| a | b |',
  '| --- |',
  '--- | ---',
  '**literal**',
  '*em* _em_',
  '~~gone~~',
  '`code`',
  '[link](https://example.com)',
  '[[note-2]]',
  '<u>under</u>',
  'a \\* b',
  'C:\\path\\',
]

type Inline = Record<string, unknown>

const hardBreak = { type: 'hardBreak' }

const block = (type: string, content: string | Inline[], attrs?: Record<string, unknown>) => ({
  type,
  ...(attrs ? { attrs } : {}),
  content: typeof content === 'string' ? [text(content)] : content,
})

const table = (rows: (string | Inline)[][]) => ({
  type: 'table',
  content: rows.map((cells) => ({
    type: 'tableRow',
    content: cells.map((cell) => ({
      type: 'tableCell',
      content: [typeof cell === 'string' ? text(cell) : cell],
    })),
  })),
})

test('text that reads as markdown syntax reads back as the same text in every kind of block', () => {
  for (const sample of SYNTAX_AS_TEXT) {
    const twoLines = [text(sample), hardBreak, text(sample)]
    const carrying = doc(
      block('paragraph', sample),
      block('paragraph', twoLines),
      block('heading', sample, { level: 2 }),
      block('bullet', sample),
      block('bullet', twoLines),
      block('numbered', sample, { style: 'decimal' }),
      block('todo', sample, { checked: false }),
      block('quote', twoLines),
      block('callout', twoLines, { kind: 'note' }),
      table([
        [sample, sample],
        [sample, sample],
      ]),
    )

    expect({ sample, doc: readBack(carrying) }).toEqual({ sample, doc: carrying })
  }
})

test('text before a link or a Note Mention does not turn the line into an image or a Synced Block', () => {
  const image = text('x', { type: 'link', attrs: { href: 'https://example.com/a.png' } })
  const mention = { type: 'noteMention', attrs: { noteId: 'note-1' } }
  const bang = doc(
    block('paragraph', [text('!'), image]),
    block('paragraph', [text('!'), mention]),
    block('bullet', [text('lead'), hardBreak, text('!'), mention]),
  )

  expect(readBack(bang)).toEqual(bang)
})

test('only the lines that would read as a table are escaped', () => {
  const lines = [text('| a |'), hardBreak, text('| b |'), hardBreak, text('| c |')]

  expect(toMarkdown(doc(block('paragraph', lines), block('bullet', '--- | ---')))).toBe(
    '| a |\n\\| b |\n| c |\n\n- --- | ---',
  )
})

test('a backslash in code before a pipe in a table cell does not split the cell', () => {
  type Tree = { content?: Tree[] }
  const coded = doc(
    table([
      [text('a\\|b', { type: 'code' }), 'c'],
      ['d', 'e'],
    ]),
  )
  const read = (readBack(coded) as Tree).content?.[0]?.content?.[0]?.content?.[0]

  expect(read?.content?.map((row) => row.content?.length)).toEqual([2, 2])
})

test('a delimiter in code does not pair with the one outside, and one in a link does', () => {
  const code = doc(block('paragraph', [text('a*'), text('b*c', { type: 'code' })]))
  const link = doc(
    block('paragraph', [
      text('*a '),
      text('x', { type: 'link', attrs: { href: 'https://example.com/*b' } }),
    ]),
  )

  expect(toMarkdown(code)).toBe('a*`b*c`')
  expect(readBack(code)).toEqual(code)
  expect(readBack(link)).toEqual(link)
})

test('ordinary sentences that read as no syntax are written without backslashes', () => {
  const sentences = [
    'snake_case',
    '#hashtag',
    'e.g. this',
    '1.5 times',
    'a-b',
    'a * b',
    '~/.claude/CLAUDE.md',
    '2*3 and _private',
    'C:\\Users\\me',
  ]
  const paragraphs = sentences.map((sentence) => ({ type: 'paragraph', content: [text(sentence)] }))

  expect(toMarkdown(doc(...paragraphs))).toBe(sentences.join('\n\n'))
})

test('a Note Mention whose name the caller does not give is written by its id alone', () => {
  const mentions = doc({
    type: 'paragraph',
    content: [
      { type: 'noteMention', attrs: { noteId: 'note-1' } },
      { type: 'text', text: ' ' },
      { type: 'noteMention', attrs: { noteId: 'note-2' } },
    ],
  })

  expect(toMarkdown(mentions, (noteId) => (noteId === 'note-2' ? '' : null))).toBe(
    '[[note-1]] [[note-2]]',
  )
  expect(toMarkdown(mentions)).toBe('[[note-1]] [[note-2]]')
})

test('the text inside nodes and marks the editor does not know is kept', () => {
  expect(toMarkdown(unknownNodes)).toBe('known inline-unknown marked\n\n# extra attrs survive')
})

test('a field of the wrong type is read as missing, without losing the other blocks', () => {
  const mismatched = doc(
    { type: 'paragraph', content: [{ type: 'text', text: 'survived' }] },
    { type: 'heading', attrs: { level: 'two' }, content: 'not-an-array' },
  )

  expect(toMarkdown(mismatched)).toBe('survived\n\n# ')
})

test('a value that is not a doc is written as its text', () => {
  expect(toMarkdown({ type: 'paragraph', content: [{ type: 'text', text: '  loose  ' }] })).toBe(
    'loose',
  )
  expect(toMarkdown(block('paragraph', '# *not* a heading'))).toBe('\\# \\*not\\* a heading')
  expect(toMarkdown('not json at all')).toBe('')
  expect(toMarkdown(null)).toBe('')
})

test('a code block holding a fence is wrapped in a longer fence', () => {
  const code = doc({
    type: 'codeBlock',
    attrs: { language: 'markdown' },
    content: [{ type: 'text', text: '```\nnested\n```' }],
  })

  expect(toMarkdown(code)).toBe('````markdown\n```\nnested\n```\n````')
})

const numbered = (style: string, value: string) => ({
  type: 'numbered',
  attrs: { style },
  content: [text(value)],
})

test('numbers count up through a run of one style, and start over after any other block', () => {
  const alpha = Array.from({ length: 28 }, (_, index) => numbered('lower-alpha', `a${index}`))
  const roman = Array.from({ length: 4 }, (_, index) => numbered('lower-roman', `r${index}`))
  const lines = toMarkdown(
    doc(
      numbered('decimal', 'one'),
      numbered('decimal', 'two'),
      { type: 'bullet', content: [{ type: 'text', text: 'break' }] },
      numbered('decimal', 'again'),
      ...alpha,
      ...roman,
    ),
  ).split('\n')

  expect(lines.slice(0, 4)).toEqual(['1. one', '2. two', '- break', '1. again'])
  expect([lines[4], lines[29], lines[30], lines[31]]).toEqual([
    'a. a0',
    'z. a25',
    'aa. a26',
    'ab. a27',
  ])
  expect(lines.slice(32)).toEqual(['i. r0', 'ii. r1', 'iii. r2', 'iv. r3'])
})
