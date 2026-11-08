import { DOMSerializer } from 'prosemirror-model'
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view'

import { columnWidths, moveColumnBorder, round, tableWidth } from './column-widths.ts'
import { nodes } from './schema.ts'
import { cellStartPos, getTableCellContext } from './table.ts'

const MIN_COLUMN_PX = 48
const EDGE_GRAB_PX = 5

function applyColumnWidths(table: HTMLTableElement, widths: number[] | null): void {
  const colgroup = table.querySelector(':scope > colgroup')
  if (!colgroup) return
  table.classList.toggle('jb-table-sized', widths !== null)
  if (!widths) {
    colgroup.replaceChildren()
    return
  }
  while (colgroup.children.length > widths.length) colgroup.lastElementChild?.remove()
  while (colgroup.children.length < widths.length) colgroup.append(document.createElement('col'))
  widths.forEach((w, i) => {
    const col = colgroup.children[i]
    if (col instanceof HTMLElement) col.style.width = `${w * 100}%`
  })
}

function widthsKey(node: PMNode): string | null {
  return columnWidths(node)?.join(',') ?? null
}

export class TableView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private widthsKey: string | null

  constructor(node: PMNode) {
    const spec = nodes.table.spec.toDOM?.(node)
    if (!spec) throw new Error('table has no toDOM')
    const { dom, contentDOM } = DOMSerializer.renderSpec(document, spec)
    if (!(dom instanceof HTMLElement) || !contentDOM) throw new Error('table toDOM has no hole')
    this.dom = dom
    this.contentDOM = contentDOM
    this.widthsKey = widthsKey(node)
  }

  update(node: PMNode): boolean {
    if (node.type !== nodes.table) return false
    const key = widthsKey(node)
    if (key !== this.widthsKey && this.dom instanceof HTMLTableElement) {
      this.widthsKey = key
      applyColumnWidths(this.dom, columnWidths(node))
    }
    return true
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !(mutation.target instanceof Node && this.contentDOM.contains(mutation.target))
  }
}

type ColumnBorder = { tablePos: number; col: number; dragging: boolean }
type ResizeMeta = { border: ColumnBorder | null }

const tableResizeKey = new PluginKey<ColumnBorder | null>('tableResize')

function setColumnBorder(view: EditorView, border: ColumnBorder | null): void {
  const current = tableResizeKey.getState(view.state)
  const same =
    current?.tablePos === border?.tablePos &&
    current?.col === border?.col &&
    current?.dragging === border?.dragging
  if (same) return
  view.dispatch(view.state.tr.setMeta(tableResizeKey, { border } satisfies ResizeMeta))
}

/** pointer が掴める境界。表の右端は本文の幅に固定なので掴ませない。 */
function borderAt(view: EditorView, event: MouseEvent): ColumnBorder | null {
  if (!(event.target instanceof Element)) return null
  const cell = event.target.closest('td, th')
  if (!cell || !view.dom.contains(cell)) return null
  const ctx = getTableCellContext(view.state.doc.resolve(view.posAtDOM(cell, 0)))
  if (!ctx) return null
  const rect = cell.getBoundingClientRect()
  let col: number
  if (rect.right - event.clientX <= EDGE_GRAB_PX) col = ctx.cellIndex
  else if (event.clientX - rect.left <= EDGE_GRAB_PX) col = ctx.cellIndex - 1
  else return null
  if (col < 0 || col >= tableWidth(ctx.tableNode) - 1) return null
  return { tablePos: ctx.tablePos, col, dragging: false }
}

/** 幅を持たない表は、いちばん長い行のセルの描画幅から比を取る。 */
function measuredWidths(tableDom: HTMLTableElement, table: PMNode): number[] | null {
  const rows = Array.from(tableDom.querySelectorAll(':scope > tbody > tr'))
  const widest = rows.find((row) => row.children.length === tableWidth(table))
  if (!widest) return null
  const px = Array.from(widest.children, (cell) => cell.getBoundingClientRect().width)
  const sum = px.reduce((a, b) => a + b, 0)
  return sum > 0 ? px.map((w) => round(w / sum)) : null
}

/** 掴んだ境界のドラッグを始め、途中で打ち切る関数を返す。打ち切りは何も dispatch しない。 */
function startDrag(
  view: EditorView,
  border: ColumnBorder,
  event: MouseEvent,
  onEnd: () => void,
): (() => void) | null {
  const table = view.state.doc.nodeAt(border.tablePos)
  const tableDom = view.nodeDOM(border.tablePos)
  if (table?.type !== nodes.table || !(tableDom instanceof HTMLTableElement)) return null
  const start = columnWidths(table) ?? measuredWidths(tableDom, table)
  const totalPx = tableDom.getBoundingClientRect().width
  if (!start || totalPx <= 0) return null
  const startX = event.clientX
  let current = start
  setColumnBorder(view, { ...border, dragging: true })

  const move = (e: MouseEvent) => {
    // 窓の外で離した mouseup は window に届かないので、ボタンが離れた move で終える
    if (e.buttons === 0) {
      up()
      return
    }
    current = moveColumnBorder(
      start,
      border.col,
      (e.clientX - startX) / totalPx,
      MIN_COLUMN_PX / totalPx,
    )
    applyColumnWidths(tableDom, current)
  }
  const stop = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    window.removeEventListener('blur', up)
    onEnd()
  }
  const up = () => {
    stop()
    const tr = view.state.tr.setMeta(tableResizeKey, { border: null } satisfies ResizeMeta)
    // 掴んだ間に表が動いたか消えたら、描きかけの幅を捨てて doc の幅に戻す
    const now = view.state.doc.nodeAt(border.tablePos)
    if (now === table && current !== start) {
      tr.setNodeAttribute(border.tablePos, 'colWidths', current)
    } else {
      applyColumnWidths(tableDom, now ? columnWidths(now) : null)
    }
    view.dispatch(tr)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
  window.addEventListener('blur', up)
  return stop
}

function edgeDecorations(state: EditorState, border: ColumnBorder): DecorationSet {
  const table = state.doc.nodeAt(border.tablePos)
  if (table?.type !== nodes.table) return DecorationSet.empty
  const decos: Decoration[] = []
  for (let r = 0; r < table.childCount; r++) {
    const row = table.child(r)
    if (border.col >= row.childCount) continue
    const pos = cellStartPos(border.tablePos, table, r, border.col)
    decos.push(
      Decoration.node(pos, pos + row.child(border.col).nodeSize, { class: 'jb-col-resize-edge' }),
    )
  }
  return DecorationSet.create(state.doc, decos)
}

export function tableResizePlugin(): Plugin<ColumnBorder | null> {
  // view が壊れた後の mouseup で dispatch しないよう、destroy でドラッグを打ち切る
  let stopDrag: (() => void) | null = null
  return new Plugin<ColumnBorder | null>({
    key: tableResizeKey,
    view: () => ({ destroy: () => stopDrag?.() }),
    state: {
      init: () => null,
      apply(tr, prev) {
        const meta = tr.getMeta(tableResizeKey) as ResizeMeta | undefined
        if (meta) return meta.border
        if (!prev || !tr.docChanged) return prev
        return prev.dragging ? { ...prev, tablePos: tr.mapping.map(prev.tablePos) } : null
      },
    },
    props: {
      decorations(state) {
        const border = tableResizeKey.getState(state)
        return border ? edgeDecorations(state, border) : null
      },
      attributes(state): Record<string, string> {
        return tableResizeKey.getState(state) ? { class: 'jb-col-resizing' } : {}
      },
      handleDOMEvents: {
        mousemove(view, event) {
          if (tableResizeKey.getState(view.state)?.dragging) return false
          setColumnBorder(view, view.editable ? borderAt(view, event) : null)
          return false
        },
        mouseleave(view) {
          if (!tableResizeKey.getState(view.state)?.dragging) setColumnBorder(view, null)
          return false
        },
        mousedown(view, event) {
          const border = tableResizeKey.getState(view.state)
          if (!border || border.dragging || event.button !== 0) return false
          event.preventDefault()
          stopDrag = startDrag(view, border, event, () => {
            stopDrag = null
          })
          return true
        },
      },
    },
  })
}
