/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'

import { Slice } from 'prosemirror-model'
import { AllSelection, EditorState, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

import fullDoc from '../../body/fixtures/full-doc.json'
import { fromMarkdown, toMarkdown } from '../../body/index.ts'
import { blockSelectionPlugin } from './block-selection.ts'
import {
  BLOCKS_MIME,
  clipboardPlugin,
  containersFromDocJson,
  type ParseMarkdown,
  type RenderMarkdown,
  serializeBlocksPayload,
} from './clipboard.ts'
import { docFromJSON } from './create-editor.ts'
import { selectBlocks } from './selection-state.ts'
import { block, contentPos, docOf, heading, para, paste } from './test-fixtures.ts'

function pasteBlocks(state: EditorState, payload: string): EditorState {
  const pasted = paste(clipboardPlugin(), state, { [BLOCKS_MIME]: payload })
  expect(pasted.handled).toBe(true)
  return pasted.state
}

describe('handlePaste と折りたたみ', () => {
  const payload = serializeBlocksPayload([block('X', para('x'))])

  test('collapsed heading 上での paste は貼り先を隠す畳みを開く', () => {
    const doc = docOf(block('H', heading('A', 2, true)), block('P', para('1')))
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, 'H', 'end')),
    })
    const after = pasteBlocks(state, payload)
    expect(after.doc.child(0).child(0).child(0).attrs.collapsed).toBe(false)
    expect(blockTexts(after)).toEqual(['A', 'x', '1'])
  })

  test('collapsed heading の block 選択への paste も同様に開く', () => {
    const doc = docOf(block('H', heading('A', 2, true)), block('P', para('1')))
    const base = EditorState.create({ doc, plugins: [blockSelectionPlugin()] })
    const state = base.apply(selectBlocks(base.tr, 'H', 'H'))
    const after = pasteBlocks(state, payload)
    const group = after.doc.child(0)
    expect(group.child(0).child(0).attrs.collapsed).toBe(false)
    expect(group.child(1).textContent).toBe('x')
  })

  test('畳まれていない貼り先では何も開かない（attrs 不変）', () => {
    const doc = docOf(block('H', heading('A', 2)), block('P', para('1')))
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, 'H', 'end')),
    })
    const after = pasteBlocks(state, payload)
    expect(after.doc.child(0).child(0).child(0).attrs.collapsed).toBe(false)
    expect(after.doc.child(0).childCount).toBe(3)
  })
})

/** fromMarkdown が返す形の doc JSON を組む（blockContainer は attrs なし） */
function mdDocJson(...contents: unknown[]): unknown {
  return {
    type: 'doc',
    content: [
      {
        type: 'blockGroup',
        content: contents.map((content) => ({ type: 'blockContainer', content: [content] })),
      },
    ],
  }
}

function pasteMarkdown(
  state: EditorState,
  text: string,
  parseMarkdown: ParseMarkdown,
): EditorState {
  const pasted = paste(clipboardPlugin({ parseMarkdown }), state, { 'text/plain': text })
  expect(pasted.handled).toBe(true)
  return pasted.state
}

/** blockGroup 直下の block の textContent 列 */
function blockTexts(state: EditorState): string[] {
  const group = state.doc.child(0)
  return [...Array(group.childCount).keys()].map((i) => group.child(i).textContent)
}

describe('markdown paste', () => {
  test('空 paragraph 上の `### hoge` は heading block に置き換わる', () => {
    const doc = docOf(block('P', para()))
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, 'P', 'start')),
    })
    const parsed = mdDocJson({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'hoge' }],
    })
    const after = pasteMarkdown(state, '### hoge', () => parsed)
    const group = after.doc.child(0)
    expect(group.childCount).toBe(1)
    const content = group.child(0).child(0)
    expect(content.type).toBe(after.schema.nodes.heading!)
    expect(content.attrs.level).toBe(3)
    expect(content.textContent).toBe('hoge')
    expect(group.child(0).attrs.id).not.toBeNull()
  })

  test('単一 paragraph は block を割らずカーソル位置へ inline 挿入する', () => {
    const doc = docOf(block('P', para('ab')))
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, 'P', 1)),
    })
    const parsed = mdDocJson({
      type: 'paragraph',
      content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }],
    })
    const after = pasteMarkdown(state, '**bold**', () => parsed)
    const group = after.doc.child(0)
    expect(group.childCount).toBe(1)
    expect(group.child(0).child(0).textContent).toBe('aboldb')
    expect(
      group
        .child(0)
        .child(0)
        .child(1)
        .marks.map((m) => m.type.name),
    ).toEqual(['bold'])
  })

  test('複数 block はカーソル block の直後に挿入される', () => {
    const doc = docOf(block('P', para('1')))
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, 'P', 'end')),
    })
    const parsed = mdDocJson(
      { type: 'bullet', content: [{ type: 'text', text: 'a' }] },
      { type: 'bullet', content: [{ type: 'text', text: 'b' }] },
    )
    const after = pasteMarkdown(state, '- a\n- b', () => parsed)
    expect(blockTexts(after)).toEqual(['1', 'a', 'b'])
  })

  test('schema に合わない doc が返ったら素のテキストで入れる', () => {
    const doc = docOf(block('P', para('x')))
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, 'P', 'end')),
    })
    const after = pasteMarkdown(state, '## raw', () => mdDocJson({ type: 'heading', content: 'x' }))
    expect(after.doc.child(0).child(0).textContent).toBe('x## raw')
  })

  test('markdown として空になる paste は素のテキストで入れる', () => {
    const doc = docOf(block('P', para('ab')))
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, 'P', 1)),
    })
    const after = pasteMarkdown(state, '  ', () => mdDocJson())
    expect(after.doc.child(0).child(0).textContent).toBe('a  b')
  })

  test('非空の text 選択は block 挿入でも置換される', () => {
    const doc = docOf(block('P', para('aaa BBB ccc')))
    const start = contentPos(doc, 'P', 'start')
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, start + 4, start + 7),
    })
    const parsed = mdDocJson(
      { type: 'bullet', content: [{ type: 'text', text: 'a' }] },
      { type: 'bullet', content: [{ type: 'text', text: 'b' }] },
    )
    const after = pasteMarkdown(state, '- a\n- b', () => parsed)
    expect(blockTexts(after)).toEqual(['aaa  ccc', 'a', 'b'])
  })

  test('containersFromDocJson は doc 形でない JSON を弾く', () => {
    expect(containersFromDocJson({ type: 'paragraph' })).toBeNull()
    expect(containersFromDocJson(null)).toBeNull()
    expect(containersFromDocJson(mdDocJson())).toEqual([])
  })
})

const noteName = (noteId: string) => (noteId === 'note-42' ? 'Target Note' : null)

const fakeElement = () => ({
  nodeType: 1,
  innerHTML: '',
  appendChild: (child: unknown) => child,
  append: () => {},
  setAttribute: () => {},
})

// copy の handler は text/html を document で組むが、bun test には DOM が無いので、組めるだけの偽物を置く。
function withFakeDocument(run: () => void): void {
  const fake = {
    createElement: fakeElement,
    createElementNS: fakeElement,
    createDocumentFragment: fakeElement,
    createTextNode: () => ({ nodeType: 3 }),
  }
  Object.defineProperty(globalThis, 'document', { value: fake, configurable: true })
  try {
    run()
  } finally {
    Reflect.deleteProperty(globalThis, 'document')
  }
}

/** 文字選択の copy と drag が text/plain に載せる文字列。 */
function copiedText(state: EditorState, renderMarkdown: RenderMarkdown, slice: Slice): string {
  const plugin = clipboardPlugin({ renderMarkdown })
  const view = { state } as unknown as EditorView
  return plugin.props.clipboardTextSerializer!.call(plugin, slice, view)
}

describe('markdown の copy と paste', () => {
  test('block を選んで copy すると、選んだ block の markdown が text/plain に載る', () => {
    const plugin = clipboardPlugin({ renderMarkdown: (json) => toMarkdown(json, noteName) })
    const base = EditorState.create({
      doc: docFromJSON(fullDoc),
      plugins: [blockSelectionPlugin()],
    })
    const view = { state: base.apply(selectBlocks(base.tr, 'b1', 'b13')) } as unknown as EditorView
    const data = new Map<string, string>()
    const event = {
      clipboardData: { setData: (type: string, value: string) => data.set(type, value) },
      preventDefault: () => {},
    } as unknown as ClipboardEvent

    withFakeDocument(() => plugin.props.handleDOMEvents!.copy!.call(plugin, view, event))

    expect(data.get('text/plain')).toBe(toMarkdown(fullDoc, noteName))
    expect(data.has(BLOCKS_MIME)).toBe(true)
  })

  test('全種類の block を含む本文を選んで copy すると、markdown が text/plain に載る', () => {
    const state = EditorState.create({ doc: docFromJSON(fullDoc) })

    const text = copiedText(
      state,
      (json) => toMarkdown(json, noteName),
      new AllSelection(state.doc).content(),
    )

    expect(text).toBe(toMarkdown(fullDoc, noteName))
  })

  test('文字を選んで copy すると、選んだ範囲だけが markdown で載る', () => {
    const doc = docOf(block('H', heading('Title', 2)), block('P', para('body text')))
    const selection = TextSelection.create(
      doc,
      contentPos(doc, 'H', 'start'),
      contentPos(doc, 'P', 4),
    )

    const text = copiedText(EditorState.create({ doc, selection }), toMarkdown, selection.content())

    expect(text).toBe('## Title\n\nbody')
  })

  test('他の app の markdown を貼ると block になり、copy すると同じ markdown に戻る', () => {
    const markdown = [
      '## Plan',
      '- [ ] open\n- [x] done\n- bullet\n    1. nested',
      '> [!tip]\n> careful',
      '```ts\nconst a = 1\n```',
      '| a | b |\n| --- | --- |\n| **c** | `d` [[note-42]] |',
      '---',
      '![](/api/assets/x.png)',
      '![[note-7#^blk-a]]',
      '![[note-9]]',
    ].join('\n\n')
    const doc = docOf(block('P', para()))
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, 'P', 'start')),
    })

    const pasted = pasteMarkdown(state, markdown, fromMarkdown)
    const types: string[] = []
    pasted.doc.child(0).forEach((container) => types.push(container.child(0).type.name))

    expect(types).toEqual([
      'heading',
      'todo',
      'todo',
      'bullet',
      'callout',
      'codeBlock',
      'table',
      'divider',
      'image',
      'syncedBlock',
      'syncedBlock',
    ])
    expect(pasted.doc.child(0).child(9).child(0).attrs).toEqual({
      noteId: 'note-7',
      blockIds: ['blk-a'],
    })
    expect(pasted.doc.child(0).child(10).child(0).attrs).toEqual({ noteId: 'note-9', blockIds: [] })
    expect(copiedText(pasted, toMarkdown, new AllSelection(pasted.doc).content())).toBe(markdown)
  })
})
