import { expect, test } from 'bun:test'

import fullDoc from './fixtures/full-doc.json'
import unknownNodes from './fixtures/unknown-nodes.json'
import { toMarkdown } from './index.ts'

const noteName = (noteId: string) => (noteId === 'note-42' ? 'Target Note' : null)

// monica の `to_markdown` が full-doc.json から書き出した markdown。Synced Block は参照のまま。
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

test('every kind of block in the full doc is written as monica wrote it', () => {
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

const numbered = (style: string, text: string) => ({
  type: 'numbered',
  attrs: { style },
  content: [{ type: 'text', text }],
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
