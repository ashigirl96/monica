import { DOMSerializer, Fragment, Node as PMNode, Slice } from 'prosemirror-model'
import { type EditorState, Plugin, TextSelection, type Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

import { deleteRange } from './commands.ts'
import { containerById, getBlockContext, rangeFromIds, rangePositions } from './context.ts'
import { expandedHeadingsDeep, revealPos } from './folding.ts'
import { openLinkMenu } from './link-menu.ts'
import { buildSyncedContainer, openPasteMenu } from './paste-menu.ts'
import { isEmptyParagraphContainer, nodes, reissueIds, schema } from './schema.ts'
import { blockSelectionKey } from './selection-state.ts'

export const BLOCKS_MIME = 'application/x-monica-blocks+json'

type BlocksPayload = {
  schemaVersion: 1
  blocks: unknown[]
  /** copy 元ノートの id。paste-and-sync のミラー参照先。旧 payload / desktop copy では欠落。 */
  sourceNoteId?: string
}

export function serializeBlocksPayload(
  containers: readonly PMNode[],
  sourceNoteId?: string,
): string {
  const payload: BlocksPayload = {
    schemaVersion: 1,
    blocks: containers.map((node) => node.toJSON() as unknown),
    ...(sourceNoteId ? { sourceNoteId } : {}),
  }
  return JSON.stringify(payload)
}

// `@monica/note/body` の toMarkdown と同じ GFM 形にする。この plain text は renderMarkdown を
// 渡さないときの代わりで、ここだけ表の形が違うと外部へ出したあと貼り戻したときに表に戻らない。
function tableToGfm(table: PMNode): string {
  const lines: string[] = []
  table.forEach((row, _offset, index) => {
    const cells: string[] = []
    let header = false
    row.forEach((cell) => {
      if (cell.attrs.header) header = true
      // `\` は import 側の escape を食わないよう二重化し、hardBreak は空白へ潰す
      const raw = cell.content.textBetween(0, cell.content.size, undefined, ' ')
      cells.push(raw.replace(/\\/g, '\\\\').replace(/\|/g, '\\|'))
    })
    lines.push(`| ${cells.join(' | ')} |`)
    if (index === 0 && header) lines.push(`| ${cells.map(() => '---').join(' | ')} |`)
  })
  return lines.join('\n')
}

export function blocksToPlainText(containers: readonly PMNode[]): string {
  const lines: string[] = []
  const walk = (container: PMNode, depth: number) => {
    const content = container.child(0)
    let text: string
    if (content.type === nodes.divider) text = '---'
    else if (content.type === nodes.syncedBlock) text = '[synced block]'
    else if (content.type === nodes.table) text = tableToGfm(content)
    else text = content.content.textBetween(0, content.content.size, undefined, '\n')
    lines.push('  '.repeat(depth) + text)
    if (container.childCount > 1) {
      container.child(1).forEach((child) => walk(child, depth + 1))
    }
  }
  for (const container of containers) walk(container, 0)
  return lines.join('\n')
}

// 外部 HTML/plain text に block ID を出さない
function stripIds(node: PMNode): PMNode {
  if (node.type === nodes.blockContainer) {
    return node.type.create(
      { ...node.attrs, id: null },
      node.content.content.map(stripIds),
      node.marks,
    )
  }
  if (node.type === nodes.blockGroup) {
    return node.type.create(node.attrs, node.content.content.map(stripIds), node.marks)
  }
  return node
}

// paste する subtree の正規化: ID 再発行 + heading の畳み解除。BLOCKS_MIME 経路
// （handlePaste）と外部 paste（transformPasted）の両方がここを通る。
function preparePasted(node: PMNode): PMNode {
  return expandedHeadingsDeep(reissueIds(node))
}

function mapSliceNodes(slice: Slice, mapNode: (node: PMNode) => PMNode): Slice {
  const mapFragment = (fragment: Fragment): Fragment =>
    Fragment.from(
      fragment.content.map((node) => {
        const mapped = mapNode(node)
        // container/group は mapNode 内で再帰済み。それ以外は子だけ辿る
        if (mapped === node && node.childCount > 0 && !node.isText) {
          return node.copy(mapFragment(node.content))
        }
        return mapped
      }),
    )
  return new Slice(mapFragment(slice.content), slice.openStart, slice.openEnd)
}

function blocksToHtml(containers: readonly PMNode[]): string {
  const serializer = DOMSerializer.fromSchema(schema)
  const holder = document.createElement('div')
  holder.append(serializer.serializeFragment(Fragment.from(containers.map(stripIds)), { document }))
  return holder.innerHTML
}

// 元 ID のままの container 群と sourceNoteId を返す。ID 再発行（plain paste）は呼び手の
// 責務 — paste-and-sync は元 blockId を参照先に使うため、ここでは reissue しない。
type ParsedBlocks = { blocks: PMNode[]; sourceNoteId: string | null }

function parseBlocksPayload(raw: string): ParsedBlocks | null {
  let payload: BlocksPayload
  try {
    payload = JSON.parse(raw) as BlocksPayload
  } catch {
    return null
  }
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.blocks)) return null
  try {
    const blocks = payload.blocks.map((json) => PMNode.fromJSON(schema, json))
    return { blocks, sourceNoteId: payload.sourceNoteId ?? null }
  } catch {
    return null
  }
}

function selectedContainers(state: EditorState): PMNode[] {
  const selection = blockSelectionKey.getState(state)
  if (!selection || selection.selectedIds.length === 0) return []
  return selection.selectedIds
    .map((id) => containerById(state.doc, id)?.node)
    .filter((node): node is PMNode => !!node)
}

/** block 選択の container 群を単一 blockGroup に包んだ doc JSON。 */
function docJsonFromContainers(containers: readonly PMNode[]): unknown {
  return {
    type: 'doc',
    content: [{ type: 'blockGroup', content: containers.map((node) => node.toJSON()) }],
  }
}

/** 単一トークンの http(s) URL の paste なら URL を返す（note-mention-menu と共有） */
export function pastedUrl(event: ClipboardEvent): string | null {
  const text = event.clipboardData?.getData('text/plain')?.trim()
  if (!text || /\s/.test(text)) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  } catch {
    return null
  }
  return text
}

// 単一 URL のペースト: プレーンリンクを即挿入し、表現の 3 択（URL/Mention/Bookmark）を
// link-menu に委ねる。選択テキストがあれば Notion 同様 link mark を付けるだけ。
function handleUrlPaste(view: EditorView, event: ClipboardEvent): boolean {
  const url = pastedUrl(event)
  if (!url) return false
  const { state } = view
  const sel = state.selection
  const ctx = getBlockContext(sel.$from)
  if (!ctx || ctx.contentNode.type === nodes.codeBlock) return false
  const linkMark = schema.marks.link.create({ href: url })
  if (!sel.empty) {
    if (!(sel instanceof TextSelection) || sel.$from.parent !== sel.$to.parent) return false
    view.dispatch(state.tr.addMark(sel.from, sel.to, linkMark))
    return true
  }
  const from = sel.from
  const tr = state.tr.replaceWith(from, from, schema.text(url, [linkMark]))
  tr.setSelection(TextSelection.create(tr.doc, from + url.length))
  openLinkMenu(tr, from, url)
  view.dispatch(tr.scrollIntoView())
  return true
}

function writeBlocksToClipboard(
  event: ClipboardEvent,
  containers: readonly PMNode[],
  sourceNoteId?: string,
  // markdown があれば text/plain に載せる（renderMarkdown が無ければインデント plain text）。
  // BLOCKS_MIME / html は常に共存させ、paste-and-sync 経路を壊さない。
  markdownPlain?: string,
): void {
  if (!event.clipboardData) return
  event.preventDefault()
  event.clipboardData.setData(BLOCKS_MIME, serializeBlocksPayload(containers, sourceNoteId))
  event.clipboardData.setData('text/html', blocksToHtml(containers))
  event.clipboardData.setData('text/plain', markdownPlain ?? blocksToPlainText(containers))
}

/** 選択範囲の doc JSON を markdown へ書き出す。copy の同期 handler から呼ぶので同期で返す。 */
export type RenderMarkdown = (docJson: unknown) => string

/** markdown text を doc JSON へ読む。 */
export type ParseMarkdown = (markdown: string) => unknown

export type ClipboardOptions = {
  /** copy 時に payload へ載せる現在ノートの id（paste-and-sync のミラー参照元）。 */
  sourceNoteId?: string
  /** paste 時に「Paste and sync」を提示するか（= resolveBlock が提供されているか）。 */
  syncPasteEnabled?: boolean
  /** 選択範囲を markdown へ投影する。未指定なら markdown コピーは無効（plain text 縮退）。 */
  renderMarkdown?: RenderMarkdown
  /** plain text paste を markdown として取り込む。未指定なら素のテキスト挿入に縮退。 */
  parseMarkdown?: ParseMarkdown
}

function selectedBlockIds(state: EditorState): readonly string[] {
  return blockSelectionKey.getState(state)?.selectedIds ?? []
}

/**
 * paste した blockContainer 列の挿入 transaction を作る。block 選択があればその直後、
 * なければ空 paragraph の置き換えかカーソル block の直後。start より前は触らないので、
 * paste-menu のライブプレビュー（replaceWith）の安定アンカーになる。
 */
function insertBlocksTr(
  state: EditorState,
  blocks: readonly PMNode[],
): { tr: Transaction; start: number } | null {
  const tr = state.tr
  const blockIds = selectedBlockIds(state)
  let start: number
  if (blockIds.length > 0) {
    const range = rangeFromIds(state, blockIds)
    if (!range) return null
    start = rangePositions(range).end
    tr.insert(start, [...blocks])
  } else {
    // 非空の text 選択は通常の paste と同じく置換対象。残すと選択されたテキストが
    // 消えないまま block が後ろに増える。
    if (!tr.selection.empty) tr.deleteSelection()
    const ctx = getBlockContext(tr.selection.$from)
    if (!ctx) return null
    // 空 paragraph（子なし）の上なら置き換え、それ以外は直後に挿入
    if (isEmptyParagraphContainer(ctx.containerNode)) {
      start = ctx.containerPos
      tr.replaceWith(start, start + ctx.containerNode.nodeSize, [...blocks])
    } else {
      start = ctx.containerPos + ctx.containerNode.nodeSize
      tr.insert(start, [...blocks])
    }
  }
  // 貼り先が collapsed heading の直後（= その heading が隠す範囲）だと、貼った
  // 内容が不可視のままになる。preparePasted が開くのは貼る側の heading だけ
  // なので、貼り先を隠している折りたたみはここで開く。
  revealPos(tr, start)
  return { tr, start }
}

/** parseMarkdown が返した doc JSON から blockContainer 列を取り出す（形が違えば null）。 */
export function containersFromDocJson(docJson: unknown): PMNode[] | null {
  try {
    const doc = PMNode.fromJSON(schema, docJson)
    if (doc.type !== nodes.doc || doc.childCount !== 1) return null
    const containers: PMNode[] = []
    doc.child(0).forEach((container) => containers.push(container))
    // fromJSON は content 制約を検証しないので、挿入前にここで弾く
    for (const container of containers) container.check()
    return containers
  } catch {
    return null
  }
}

function insertPlainText(view: EditorView, text: string): void {
  view.dispatch(view.state.tr.insertText(text).scrollIntoView())
}

// parse 済み markdown の挿入。単一の paragraph（子なし）だけは block を増やさず
// カーソル位置へ inline 挿入する（文中への語句 paste が block を割らないように）。
function applyParsedMarkdown(view: EditorView, docJson: unknown, rawText: string): void {
  const containers = containersFromDocJson(docJson)
  if (!containers) return insertPlainText(view, rawText)
  // markdown として空（空白のみ・改行のみ）でも paste は落とさず素のテキストで入れる
  if (containers.length === 0) return insertPlainText(view, rawText)
  const blocks = containers.map(preparePasted)
  const only = blocks.length === 1 ? blocks[0] : undefined
  // block 選択中は inline 挿入だと選択範囲の中へ潜り込む。block 経路で選択の後ろへ入れる
  if (
    selectedBlockIds(view.state).length === 0 &&
    only &&
    only.childCount === 1 &&
    only.child(0).type === nodes.paragraph
  ) {
    const inline = new Slice(only.child(0).content, 0, 0)
    view.dispatch(view.state.tr.replaceSelection(inline).scrollIntoView())
    return
  }
  const inserted = insertBlocksTr(view.state, blocks)
  if (!inserted) return insertPlainText(view, rawText)
  view.dispatch(inserted.tr.scrollIntoView())
}

// plain text paste の markdown 取り込み。text/html を持つ rich paste は ProseMirror の
// parseDOM に任せ、text/plain のみのときだけ parseMarkdown へ回す。
function handleMarkdownPaste(
  view: EditorView,
  event: ClipboardEvent,
  parseMarkdown: ParseMarkdown | undefined,
): boolean {
  if (!parseMarkdown || !event.clipboardData) return false
  if (event.clipboardData.getData('text/html')) return false
  const text = event.clipboardData.getData('text/plain')
  if (!text) return false
  const ctx = getBlockContext(view.state.selection.$from)
  // codeBlock 内は markdown 解釈せず素のテキストのまま（default 挿入）
  if (!ctx || ctx.contentNode.type === nodes.codeBlock) return false
  applyParsedMarkdown(view, parseMarkdown(text), text)
  return true
}

export function clipboardPlugin(options: ClipboardOptions = {}): Plugin {
  const { renderMarkdown } = options
  const markdownOf = (containers: readonly PMNode[]) =>
    renderMarkdown?.(docJsonFromContainers(containers))

  return new Plugin({
    props: {
      // text mode copy は ProseMirror 標準に任せつつ、外部へ出る HTML から ID を剥がす
      transformCopied: (slice) => mapSliceNodes(slice, stripIds),
      // 外部・copy 由来 paste は ID 再発行（重複 ID は normalizer の防衛もある）
      transformPasted: (slice) => mapSliceNodes(slice, preparePasted),
      // text 選択の text/plain を markdown に差し替える。slice は selection.content() なので
      // doc から続く形のまま doc JSON に載る。block 選択は copy ハンドラが preventDefault するので
      // ここは通らない。
      ...(renderMarkdown
        ? {
            clipboardTextSerializer: (slice: Slice) =>
              renderMarkdown({ type: 'doc', content: slice.content.toJSON() ?? [] }),
          }
        : {}),

      handleDOMEvents: {
        copy(view, event) {
          const containers = selectedContainers(view.state)
          if (containers.length === 0) return false
          writeBlocksToClipboard(event, containers, options.sourceNoteId, markdownOf(containers))
          return true
        },
        cut(view, event) {
          const containers = selectedContainers(view.state)
          if (containers.length === 0) return false
          // cut は元ブロックを削除するので sourceNoteId を載せない。載せると paste-and-sync
          // が「消えたブロック」を指す dangling ミラーになる（cut は move であって参照元にならない）。
          writeBlocksToClipboard(event, containers, undefined, markdownOf(containers))
          const selection = blockSelectionKey.getState(view.state)
          const range = selection ? rangeFromIds(view.state, selection.selectedIds) : null
          if (range) view.dispatch(deleteRange(view.state, range))
          return true
        },
      },

      handlePaste(view, event) {
        const raw = event.clipboardData?.getData(BLOCKS_MIME)
        if (!raw) {
          if (handleUrlPaste(view, event)) return true
          return handleMarkdownPaste(view, event, options.parseMarkdown)
        }
        const parsed = parseBlocksPayload(raw)
        if (!parsed || parsed.blocks.length === 0) return false
        const { blocks: originals, sourceNoteId } = parsed
        // plain paste は常に ID 再発行（重複 ID は normalizer の防衛もある）。
        // originals は synced mirror が元 ID で参照するので触らない。
        const plain = originals.map(preparePasted)

        const inserted = insertBlocksTr(view.state, plain)
        if (!inserted) return false
        const { tr, start } = inserted

        // paste-and-sync が可能なら「Paste as」メニューを相乗りさせる。plugin 未登録
        // （resolveBlock 不在）や旧 payload（sourceNoteId 欠落）なら plain のまま。
        if (
          options.syncPasteEnabled &&
          sourceNoteId &&
          originals.every((container) => container.attrs.id !== null)
        ) {
          openPasteMenu(tr, {
            start,
            plain,
            synced: [buildSyncedContainer(originals, sourceNoteId)],
          })
        }
        view.dispatch(tr.scrollIntoView())
        return true
      },
    },
  })
}
