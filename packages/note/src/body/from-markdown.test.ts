import { expect, test } from 'bun:test'

import { fromMarkdown, toMarkdown } from './index.ts'

const roundtrip = (markdown: string) => toMarkdown(fromMarkdown(markdown))

// エディタの全種類の block を、toMarkdown が書き出す形のまま並べたもの。読んで書き戻すと元に戻る。
const CANONICAL_MD = `# Title

plain **bold** *italic* ***styled*** <u>under</u> ~~gone~~ \`mono\` [link](https://example.com) [[note-42]]

## Section

- [ ] open task
- [x] done task
- bullet
    - nested bullet
    1. nested first
1. first
2. second
a. alpha
i. roman

> quoted
> lines

> [!warning]
> careful

\`\`\`rust
fn main() {}
\`\`\`

---

![[note-7#^blk-a]]
![[note-7#^blk-b]]

![](/api/assets/abc.png)

| head A | head B |
| --- | --- |
| **bold** \\| pipe | \`code\` |
|  | plain |`

test('markdown in the form toMarkdown writes reads back to the same markdown', () => {
  expect(roundtrip(CANONICAL_MD)).toBe(CANONICAL_MD)
})

type Json = {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: unknown
  content?: Json[]
}

const docOf = (markdown: string) => fromMarkdown(markdown) as unknown as { content: [Json] }

/** blockGroup の n 番目の blockContainer の中身（先頭の子）。 */
const blockAt = (markdown: string, index: number) =>
  docOf(markdown).content[0].content?.[index]?.content?.[0]

const containersOf = (markdown: string) => docOf(markdown).content[0].content ?? []

test('heading levels past 3 are clamped to the deepest the editor has', () => {
  const markdown = '# h1\n## h2\n### h3\n#### h4'

  expect([0, 1, 2, 3].map((index) => blockAt(markdown, index)?.attrs?.level)).toEqual([1, 2, 3, 3])
})

test('a hash with no space after it is not a heading', () => {
  expect(blockAt('#hashtag', 0)?.type).toBe('paragraph')
})

test('each list marker becomes its kind of block and numbered style', () => {
  const markdown = '1. a\n1) b\na. c\nii. d\n- e\n* f\n- [ ] g\n[x] h'

  expect(
    [0, 1, 2, 3, 4, 5, 6, 7].map((index) => {
      const block = blockAt(markdown, index)
      return [block?.type, block?.attrs?.style ?? block?.attrs?.checked]
    }),
  ).toEqual([
    ['numbered', 'decimal'],
    ['numbered', 'decimal'],
    ['numbered', 'lower-alpha'],
    ['numbered', 'lower-roman'],
    ['bullet', undefined],
    ['bullet', undefined],
    ['todo', false],
    ['todo', true],
  ])
})

test('a sentence starting with a letter and a period is not a list', () => {
  expect(blockAt('e.g. some example', 0)?.type).toBe('paragraph')
})

test('deeper indentation nests blocks under the list item above', () => {
  const containers = containersOf('- parent\n    - child\n        - grandchild\n- sibling')
  const [parent, sibling] = containers
  const child = parent?.content?.[1]?.content?.[0]
  const grandchild = child?.content?.[1]?.content?.[0]

  expect(containers).toHaveLength(2)
  expect(child?.content?.[0]?.content?.[0]?.text).toBe('child')
  expect(grandchild?.content?.[0]?.content?.[0]?.text).toBe('grandchild')
  expect(sibling?.content?.[0]?.content?.[0]?.text).toBe('sibling')
})

test('quote lines become one quote joined by hard breaks', () => {
  expect(blockAt('> first\n> second', 0)).toEqual({
    type: 'quote',
    content: [
      { type: 'text', text: 'first' },
      { type: 'hardBreak' },
      { type: 'text', text: 'second' },
    ],
  })
})

test('a callout keeps its kind and the lines below it', () => {
  expect(blockAt('> [!warning]\n> careful\n> here', 0)).toEqual({
    type: 'callout',
    attrs: { kind: 'warning' },
    content: [
      { type: 'text', text: 'careful' },
      { type: 'hardBreak' },
      { type: 'text', text: 'here' },
    ],
  })
})

test('an unclosed fence runs to the end, and a fence with no language leaves it to the schema', () => {
  expect(blockAt('```\ncode line\nstill code', 0)).toEqual({
    type: 'codeBlock',
    content: [{ type: 'text', text: 'code line\nstill code' }],
  })
})

test('a fence keeps the indentation inside the code', () => {
  const [item] = containersOf('- item\n    ```python\n    if x:\n        y()\n    ```')

  expect(item?.content?.[1]?.content?.[0]?.content?.[0]).toEqual({
    type: 'codeBlock',
    attrs: { language: 'python' },
    content: [{ type: 'text', text: 'if x:\n    y()' }],
  })
})

test('consecutive references into one Note become one Synced Block', () => {
  const markdown = '![[note-7#^a]]\n![[note-7#^b]]\n![[note-8#^c]]\n\n![[note-9]]'

  expect([0, 1, 2].map((index) => blockAt(markdown, index))).toEqual([
    { type: 'syncedBlock', attrs: { noteId: 'note-7', blockIds: ['a', 'b'] } },
    { type: 'syncedBlock', attrs: { noteId: 'note-8', blockIds: ['c'] } },
    { type: 'syncedBlock', attrs: { noteId: 'note-9', blockIds: [] } },
  ])
})

test('an image is made only from an image of tania or an http(s) URL', () => {
  const markdown =
    '![](/api/assets/a.png)\n\n![](https://example.com/b.png)\n\n![](data:image/png;base64,AAA)'

  expect(blockAt(markdown, 0)).toEqual({ type: 'image', attrs: { src: '/api/assets/a.png' } })
  expect(blockAt(markdown, 1)?.type).toBe('image')
  expect(blockAt(markdown, 2)?.type).toBe('paragraph')
})

test('nested marks are sorted in the order of the schema', () => {
  expect(blockAt('[**Marked**](https://example.com/y)', 0)?.content).toEqual([
    {
      type: 'text',
      text: 'Marked',
      marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com/y' } }],
    },
  ])
})

test('a Note Mention drops the name written after the bar', () => {
  expect(blockAt('see [[note-42|Target Note]] now', 0)?.content).toEqual([
    { type: 'text', text: 'see ' },
    { type: 'noteMention', attrs: { noteId: 'note-42' } },
    { type: 'text', text: ' now' },
  ])
})

test('an underscore inside a word is not emphasis', () => {
  expect(blockAt('snake_case_name stays', 0)?.content).toEqual([
    { type: 'text', text: 'snake_case_name stays' },
  ])
})

test('a backslash escapes punctuation', () => {
  expect(blockAt('\\*not em\\* and \\[not link\\](x)', 0)?.content).toEqual([
    { type: 'text', text: '*not em* and [not link](x)' },
  ])
})

test('an escaped closing delimiter does not close the mark it is inside', () => {
  expect(blockAt('*a\\*b* ~~c\\~d~~ <u>e\\</u>f</u> *g\\\\*', 0)?.content).toEqual([
    { type: 'text', text: 'a*b', marks: [{ type: 'italic' }] },
    { type: 'text', text: ' ' },
    { type: 'text', text: 'c~d', marks: [{ type: 'strike' }] },
    { type: 'text', text: ' ' },
    { type: 'text', text: 'e</u>f', marks: [{ type: 'underline' }] },
    { type: 'text', text: ' ' },
    { type: 'text', text: 'g\\', marks: [{ type: 'italic' }] },
  ])
})

test('an escaped bracket stays inside a link label and a Note Mention', () => {
  expect(blockAt('[see \\[1\\]](https://example.com) [[note-1|a \\[b\\]]]', 0)?.content).toEqual([
    {
      type: 'text',
      text: 'see [1]',
      marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
    },
    { type: 'text', text: ' ' },
    { type: 'noteMention', attrs: { noteId: 'note-1' } },
  ])
})

test('a closing delimiter inside a code span does not close the mark around it', () => {
  expect(blockAt('*`a*b`* [`a]b`](https://example.com)', 0)?.content).toEqual([
    { type: 'text', text: 'a*b', marks: [{ type: 'italic' }, { type: 'code' }] },
    { type: 'text', text: ' ' },
    {
      type: 'text',
      text: 'a]b',
      marks: [{ type: 'code' }, { type: 'link', attrs: { href: 'https://example.com' } }],
    },
  ])
})

test('a bracket in the id of a Note Mention leaves it as text', () => {
  expect(blockAt('[[note\\]1]]', 0)?.content).toEqual([{ type: 'text', text: '[[note]1]]' }])
})

test('delimiters without a pair stay as they are', () => {
  expect(blockAt('2 * 3 * 4 = 24 and a_b', 0)?.content).toEqual([
    { type: 'text', text: '2 * 3 * 4 = 24 and a_b' },
  ])
})

test('empty markdown gives an empty block group', () => {
  expect(containersOf('')).toEqual([])
})

test('a GFM table takes its header from the delimiter row and pads short rows', () => {
  const table = blockAt('| a | b |\n| --- | --- |\n| c |', 0)

  expect(table).toEqual({
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          { type: 'tableCell', attrs: { header: true }, content: [{ type: 'text', text: 'a' }] },
          { type: 'tableCell', attrs: { header: true }, content: [{ type: 'text', text: 'b' }] },
        ],
      },
      {
        type: 'tableRow',
        content: [
          { type: 'tableCell', content: [{ type: 'text', text: 'c' }] },
          { type: 'tableCell' },
        ],
      },
    ],
  })
})

test('a table without a delimiter row has no header', () => {
  const rows = blockAt('| a |\n| b |', 0)?.content

  expect(rows).toHaveLength(2)
  expect(rows?.[0]?.content?.[0]?.attrs).toBeUndefined()
})

test('a single line between pipes stays a paragraph', () => {
  expect(blockAt('| not a table |', 0)?.type).toBe('paragraph')
})

test('an escaped pipe stays inside its cell', () => {
  const cell = blockAt('| a \\| b | c |\n| d | e |', 0)?.content?.[0]?.content?.[0]

  expect(cell?.content).toEqual([{ type: 'text', text: 'a | b' }])
})

test('a cell ending in a backslash before an escaped pipe reads back the same', () => {
  const markdown = '| a \\\\\\| b | c |\n| --- | --- |\n| d | e |'
  const header = blockAt(markdown, 0)?.content?.[0]?.content

  expect(header).toHaveLength(2)
  expect(header?.[0]?.content).toEqual([{ type: 'text', text: 'a \\| b' }])
  expect(roundtrip(markdown)).toBe(markdown)
})

test('with a delimiter row, rows may leave out the outer pipes', () => {
  const table = blockAt('a | b\n--- | ---\nc | d', 0)

  expect(table?.type).toBe('table')
  expect(table?.content).toHaveLength(2)
  expect(table?.content?.[0]?.content?.[1]).toEqual({
    type: 'tableCell',
    attrs: { header: true },
    content: [{ type: 'text', text: 'b' }],
  })
  expect(table?.content?.[1]?.content?.[0]?.content).toEqual([{ type: 'text', text: 'c' }])
})

test('pipes in prose with no delimiter row stay one wrapped paragraph', () => {
  const containers = containersOf('foo | bar\nbaz | qux')

  expect(containers).toHaveLength(1)
  expect(containers[0]?.content?.[0]?.type).toBe('paragraph')
})

test('a soft-wrapped paragraph stays one paragraph, and only a blank line splits it', () => {
  const containers = containersOf('This is a\nwrapped paragraph\n\nnext one')

  expect(containers.map((container) => container.content?.[0])).toEqual([
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'This is a' },
        { type: 'hardBreak' },
        { type: 'text', text: 'wrapped paragraph' },
      ],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'next one' }] },
  ])
})

test('a wrapped line stops at the next construct, and a heading takes one line only', () => {
  const markdown = 'intro line\n# Title\nbody\n- item\ncont\n\n```\nfence\n```'

  expect(containersOf(markdown).map((container) => container.content?.[0]?.type)).toEqual([
    'paragraph',
    'heading',
    'paragraph',
    'bullet',
    'codeBlock',
  ])
  expect(blockAt(markdown, 3)?.content).toEqual([
    { type: 'text', text: 'item' },
    { type: 'hardBreak' },
    { type: 'text', text: 'cont' },
  ])
})

test('hard breaks in a paragraph and a list item read back the same', () => {
  const markdown = 'wrapped one\nwrapped two\n\n- item\nlazy line'

  expect(roundtrip(markdown)).toBe(markdown)
})

test('a wrapped line stops before a table without outer pipes', () => {
  const markdown = 'intro\na | b\n--- | ---\nc | d'

  expect(blockAt(markdown, 0)?.content).toEqual([{ type: 'text', text: 'intro' }])
  expect(blockAt(markdown, 1)?.type).toBe('table')
})

test('a code span keeps the markdown inside it as it is', () => {
  expect(blockAt('`**not bold**` after', 0)?.content).toEqual([
    { type: 'text', text: '**not bold**', marks: [{ type: 'code' }] },
    { type: 'text', text: ' after' },
  ])
})

test('a code span padded with a space on both ends drops one space from each end', () => {
  expect(blockAt('`` `a ``  `  b  `  `   `  ` c`', 0)?.content).toEqual([
    { type: 'text', text: '`a', marks: [{ type: 'code' }] },
    { type: 'text', text: '  ' },
    { type: 'text', text: ' b ', marks: [{ type: 'code' }] },
    { type: 'text', text: '  ' },
    { type: 'text', text: '   ', marks: [{ type: 'code' }] },
    { type: 'text', text: '  ' },
    { type: 'text', text: ' c', marks: [{ type: 'code' }] },
  ])
})

test('a link keeps balanced parentheses in its href', () => {
  expect(blockAt('[x](https://en.wikipedia.org/wiki/Foo_(film)) end', 0)?.content).toEqual([
    {
      type: 'text',
      text: 'x',
      marks: [{ type: 'link', attrs: { href: 'https://en.wikipedia.org/wiki/Foo_(film)' } }],
    },
    { type: 'text', text: ' end' },
  ])
})

test('indentation deeper than 64 levels is flattened into siblings', () => {
  const markdown = Array.from({ length: 2000 }, (_, depth) => `${' '.repeat(depth)}- x`).join('\n')
  let depth = 0
  for (let group = containersOf(markdown); group.length > 0; depth++) {
    group = group[0]?.content?.[1]?.content ?? []
  }

  expect(depth).toBe(64)
  expect(containersOf(markdown).length).toBe(1)
})
