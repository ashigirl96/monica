import { expect, test } from 'bun:test'

import { fromMarkdown, toMarkdown } from './index.ts'

// 記号の組み合わせは固定のテストでは数え尽くせないので、記号の多い文字・mark・hardBreak・Note Mention・
// 入れ子の list・表を乱択で組んだ doc を往復させる。seed を固定するので、落ちる doc は毎回同じになる。

type Node = {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: Node[]
  content?: Node[]
}

const SYMBOLS = Array.from('#-*+_~`[]()<>/u!|.:1aix \\^')

const EMPHASIS = new Set(['bold', 'italic', 'strike'])

const LIST = new Set(['bullet', 'numbered', 'todo'])

const noteName = (noteId: string) => (noteId === 'note-1' ? 'n[a]me|*x*\\' : null)

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Generator {
  private readonly next: () => number

  constructor(seed: number) {
    this.next = mulberry32(seed)
  }

  doc(): Node {
    const blocks = this.times(1, 4, () => this.container(true))
    return { type: 'doc', content: [{ type: 'blockGroup', content: blocks }] }
  }

  private container(nest: boolean): Node {
    const content = this.block()
    if (!nest || !LIST.has(content.type) || this.next() < 0.5) {
      return { type: 'blockContainer', content: [content] }
    }
    const children = this.times(1, 2, () => this.container(false))
    return { type: 'blockContainer', content: [content, { type: 'blockGroup', content: children }] }
  }

  private block(): Node {
    const lines = () => this.inlines(this.between(1, 3), false)
    switch (
      this.pick(['paragraph', 'heading', 'bullet', 'numbered', 'todo', 'quote', 'callout', 'table'])
    ) {
      case 'paragraph':
        return { type: 'paragraph', content: lines() }
      // 見出しの中の改行は、続く行を別の block として読む。
      case 'heading':
        return {
          type: 'heading',
          attrs: { level: this.between(1, 3) },
          content: this.inlines(1, false),
        }
      case 'bullet':
        return { type: 'bullet', content: lines() }
      case 'numbered':
        return { type: 'numbered', attrs: { style: 'decimal' }, content: lines() }
      case 'todo':
        return { type: 'todo', attrs: { checked: this.next() < 0.5 }, content: lines() }
      case 'quote':
        return { type: 'quote', content: lines() }
      case 'callout':
        return { type: 'callout', attrs: { kind: 'note' }, content: lines() }
      default:
        return this.table()
    }
  }

  private table(): Node {
    const width = this.between(1, 2)
    const header = this.next() < 0.5
    const rows = this.times(2, 3, (row) => ({
      type: 'tableRow',
      content: this.times(width, width, () => ({
        type: 'tableCell',
        ...(header && row === 0 ? { attrs: { header: true } } : {}),
        content: this.inlines(1, true),
      })),
    }))
    return { type: 'table', content: rows }
  }

  // セルは hardBreak を空白にして 1 行に書き、両端の空白を外して読む。
  private inlines(lineCount: number, cell: boolean): Node[] {
    const out: Node[] = []
    for (let line = 0; line < lineCount; line++) {
      if (line > 0) out.push({ type: 'hardBreak' })
      this.times(1, 3, (segment) => {
        if (this.next() < 0.1) {
          out.push({ type: 'noteMention', attrs: { noteId: this.pick(['note-1', 'note-2']) } })
          return
        }
        let text = this.word()
        // 行頭の空白は往復しない。
        if (segment === 0) text = text.replace(/^ +/, 'a')
        if (cell) text = text.trim() || 'a'
        const marks = this.marks(text)
        const last = out.at(-1)
        if (last?.type === 'text' && JSON.stringify(last.marks) === JSON.stringify(marks)) {
          last.text += text
          return
        }
        out.push(marks ? { type: 'text', text, marks } : { type: 'text', text })
      })
    }
    return out
  }

  // 強調は空白の隣で開きも閉じもしないので、両端が空白の文字には付けない（escape の前から）。並びは schema の mark の順。
  private marks(text: string): Node[] | undefined {
    if (this.next() < 0.6) return undefined
    const edgesOk = !text.startsWith(' ') && !text.endsWith(' ')
    const types = new Set([this.pick(['bold', 'italic', 'underline', 'strike', 'code', 'link'])])
    if (this.next() < 0.3) types.add(this.pick(['bold', 'italic', 'underline', 'strike', 'code']))
    const marks = ['bold', 'italic', 'underline', 'strike', 'code', 'link']
      .filter((type) => types.has(type) && (edgesOk || !EMPHASIS.has(type)))
      .map((type) =>
        type === 'link' ? { type, attrs: { href: 'https://example.com/*a_b|c\\|d' } } : { type },
      )
    return marks.length > 0 ? marks : undefined
  }

  private word(): string {
    return this.times(1, 8, () => this.pick(SYMBOLS)).join('')
  }

  private times<T>(min: number, max: number, make: (index: number) => T): T[] {
    return Array.from({ length: this.between(min, max) }, (_, index) => make(index))
  }

  private between(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  private pick<T>(items: T[]): T {
    return items[Math.floor(this.next() * items.length)]!
  }
}

test('docs built at random from symbols, marks, mentions, lists and tables read back the same', () => {
  const generator = new Generator(176)
  for (let run = 0; run < 2000; run++) {
    const doc = generator.doc()
    const markdown = toMarkdown(doc, noteName)

    expect({ markdown, doc: fromMarkdown(markdown) as unknown }).toEqual({ markdown, doc })
  }
})
