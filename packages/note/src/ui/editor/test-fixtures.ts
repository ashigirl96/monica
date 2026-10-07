import { Slice } from 'prosemirror-model'
import type { Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { Command, Plugin, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

import { containerById } from './context.ts'
import { createContainer, nodes, schema } from './schema.ts'

// テスト専用: doc fixture builder、位置解決 helper、stub view で plugin を呼ぶ helper。

export function para(text = ''): PMNode {
  return nodes.paragraph.create(null, text ? schema.text(text) : undefined)
}

export function todo(text = '', checked = false): PMNode {
  return nodes.todo.create({ checked }, text ? schema.text(text) : undefined)
}

export function bullet(text = ''): PMNode {
  return nodes.bullet.create(null, text ? schema.text(text) : undefined)
}

export function heading(text: string, level = 1, collapsed = false): PMNode {
  return nodes.heading.create({ level, collapsed }, text ? schema.text(text) : undefined)
}

export function code(text = ''): PMNode {
  return nodes.codeBlock.create(null, text ? schema.text(text) : undefined)
}

export function divider(): PMNode {
  return nodes.divider.create()
}

export function callout(text = '', collapsed = false): PMNode {
  return nodes.callout.create({ collapsed }, text ? schema.text(text) : undefined)
}

export function toggle(text = '', open = true): PMNode {
  return nodes.toggle.create({ open }, text ? schema.text(text) : undefined)
}

export function tableOf(rows: string[][], headerFirst = false): PMNode {
  return nodes.table.create(
    null,
    rows.map((cells, r) =>
      nodes.tableRow.create(
        null,
        cells.map((text) =>
          nodes.tableCell.create(
            { header: headerFirst && r === 0 },
            text ? schema.text(text) : undefined,
          ),
        ),
      ),
    ),
  )
}

export function block(id: string, content: PMNode, children: PMNode[] = []): PMNode {
  return createContainer(content, children, id)
}

export function docOf(...blocks: PMNode[]): PMNode {
  return nodes.doc.create(null, nodes.blockGroup.create(null, blocks))
}

export function posOf(doc: PMNode, id: string): number {
  const entry = containerById(doc, id)
  if (!entry) throw new Error(`no container ${id}`)
  return entry.pos
}

/** id の block の blockContent 内 offset を doc position に解決する */
export function contentPos(doc: PMNode, id: string, offset: number | 'start' | 'end'): number {
  const entry = containerById(doc, id)
  if (!entry) throw new Error(`no container ${id}`)
  const base = entry.pos + 2
  if (offset === 'start') return base
  if (offset === 'end') return base + entry.node.child(0).content.size
  return base + offset
}

export function cellPositions(doc: PMNode): number[] {
  const out: number[] = []
  doc.descendants((node, pos) => {
    if (node.type === nodes.tableCell) out.push(pos)
    return true
  })
  return out
}

/** n 番目（文書順）のセル先頭にカーソルを置いた state */
export function stateInCell(doc: PMNode, cellIndex: number, offset = 0): EditorState {
  const pos = cellPositions(doc)[cellIndex]!
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos + 1 + offset) })
}

export function run(
  state: EditorState,
  command: Command,
): { state: EditorState; handled: boolean } {
  let next = state
  const handled = command(state, (tr) => {
    next = state.apply(tr)
  })
  return { state: next, handled }
}

/** dispatch は EditorView と同じく state.apply で当てるので、appendTransaction も走る */
export function paste(
  plugin: Plugin,
  state: EditorState,
  data: Record<string, string>,
): { state: EditorState; handled: boolean } {
  const holder = { state }
  const view = {
    get state() {
      return holder.state
    },
    dispatch: (tr: Transaction) => {
      holder.state = holder.state.apply(tr)
    },
  } as unknown as EditorView
  const event = {
    clipboardData: { getData: (type: string) => data[type] ?? '' },
  } as unknown as ClipboardEvent
  const handled = plugin.props.handlePaste?.call(plugin, view, event, Slice.empty) === true
  return { state: holder.state, handled }
}

/** block 't'（todo）に当てると、id を書く AttrStep 以外の step を含む transaction になる組み立て方 */
export const beyondBlockIds: [string, (state: EditorState) => Transaction][] = [
  [
    'id を書く step の後に文字の入力',
    (state) =>
      state.tr
        .setNodeAttribute(posOf(state.doc, 't'), 'id', 'renamed')
        .insertText('!', contentPos(state.doc, 't', 'end')),
  ],
  [
    '文字の入力の後に id を書く step',
    (state) =>
      state.tr
        .insertText('!', contentPos(state.doc, 't', 'end'))
        .setNodeAttribute(posOf(state.doc, 't'), 'id', 'renamed'),
  ],
  [
    'id 以外の attr を書く step',
    (state) => state.tr.setNodeAttribute(posOf(state.doc, 't') + 1, 'checked', true),
  ],
]
