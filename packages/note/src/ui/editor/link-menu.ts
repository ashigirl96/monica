import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

import type { LinkMetadata } from '../../contract.ts'
import { appendEmptyParagraphAfter } from './commands.ts'
import { getBlockContext } from './context.ts'
import { linkMenuKey } from './menu-keys.ts'
import type { LinkMenuActiveState, LinkMenuState, PreviewKind } from './menu-keys.ts'
import { createMenuOverlay, menuItemButton, positionMenuAt } from './menu-overlay.ts'
import { onlyWritesBlockIds } from './normalizer.ts'
import { createContainer, nodes, schema } from './schema.ts'

export type FetchLinkMetadata = (url: string) => Promise<LinkMetadata | null>

type LinkMenuMeta =
  | { type: 'open'; from: number; url: string }
  | { type: 'close' }
  | { type: 'set'; state: LinkMenuActiveState }

const EMPTY_META: LinkMetadata = {
  title: null,
  description: null,
  image: null,
  favicon: null,
  siteName: null,
}

/** clipboard の URL ペーストが、挿入 Transaction にメニュー表示を相乗りさせるための meta */
export function openLinkMenu(tr: Transaction, from: number, url: string): Transaction {
  return tr.setMeta(linkMenuKey, { type: 'open', from, url } satisfies LinkMenuMeta)
}

type LinkMenuItem = { id: PreviewKind; label: string }

const ITEMS: LinkMenuItem[] = [
  { id: 'url', label: 'URL' },
  { id: 'mention', label: 'Mention' },
  { id: 'bookmark', label: 'Bookmark' },
]

function urlText(url: string) {
  return schema.text(url, [schema.marks.link.create({ href: url })])
}

function mentionNode(url: string, meta: LinkMetadata | null): PMNode {
  return nodes.linkMention.create({
    href: url,
    title: meta?.title ?? url,
    favicon: meta?.favicon ?? null,
  })
}

function bookmarkAttrs(url: string, meta: LinkMetadata | null) {
  return {
    href: url,
    title: meta?.title ?? null,
    description: meta?.description ?? null,
    thumbnail: meta?.image ?? null,
    favicon: meta?.favicon ?? null,
    siteName: meta?.siteName ?? null,
  }
}

/** 現 preview をプレーン URL テキストに戻してから target の表現を作る（常に url 経由の 1 tr）。
    from より前は一切触らないため、from は全遷移を通じて安定アンカーになる */
export function previewTransaction(
  state: EditorState,
  s: LinkMenuActiveState,
  target: PreviewKind,
): { tr: Transaction; next: LinkMenuActiveState } | null {
  const tr = state.tr
  if (s.preview === 'mention') {
    tr.replaceWith(s.from, s.from + 1, urlText(s.url))
  } else if (s.preview === 'bookmark' && s.bookmarkPos !== null) {
    if (s.extraParaPos !== null) {
      // URL 単独段落 case: 追加した空 paragraph を消し、bookmark を段落に戻す
      const extra = tr.doc.nodeAt(s.extraParaPos)
      if (extra) tr.delete(s.extraParaPos, s.extraParaPos + extra.nodeSize)
      tr.replaceWith(s.bookmarkPos, s.bookmarkPos + 1, nodes.paragraph.create(null, urlText(s.url)))
    } else {
      // 前後テキストあり case: 挿入した bookmark container を消し、URL テキストを戻す
      const containerPos = s.bookmarkPos - 1
      const container = tr.doc.nodeAt(containerPos)
      if (container) tr.delete(containerPos, containerPos + container.nodeSize)
      tr.insert(s.from, urlText(s.url))
    }
  }
  const end = s.from + s.url.length
  const base: LinkMenuActiveState = {
    ...s,
    preview: 'url',
    caret: end,
    bookmarkPos: null,
    extraParaPos: null,
  }
  if (target === 'url') {
    tr.setSelection(TextSelection.create(tr.doc, end))
    return { tr, next: base }
  }
  if (target === 'mention') {
    tr.replaceWith(s.from, end, mentionNode(s.url, s.meta))
    tr.setSelection(TextSelection.create(tr.doc, s.from + 1))
    return { tr, next: { ...base, preview: 'mention', caret: s.from + 1 } }
  }
  tr.delete(s.from, end)
  const ctx = getBlockContext(tr.doc.resolve(s.from))
  if (!ctx) return null
  const bookmark = nodes.bookmark.create(bookmarkAttrs(s.url, s.meta))
  if (ctx.contentNode.type === nodes.paragraph && ctx.contentNode.content.size === 0) {
    // URL 単独の段落だった → contentNode ごと bookmark に差し替え、
    // divider 同様カーソルは直後の空 paragraph へ移す
    tr.replaceWith(ctx.contentPos, ctx.contentPos + ctx.contentNode.nodeSize, bookmark)
    const container = tr.doc.nodeAt(ctx.containerPos)
    if (!container) return null
    const extraParaPos = ctx.containerPos + container.nodeSize
    appendEmptyParagraphAfter(tr, ctx.containerPos)
    return {
      tr,
      next: {
        ...base,
        preview: 'bookmark',
        caret: extraParaPos + 2,
        bookmarkPos: ctx.contentPos,
        extraParaPos,
      },
    }
  }
  // 前後にテキストが残る → 現 container の直後に bookmark block を挿入
  const insertAt = ctx.containerPos + ctx.containerNode.nodeSize
  tr.insert(insertAt, createContainer(bookmark))
  tr.setSelection(TextSelection.create(tr.doc, s.from))
  return {
    tr,
    next: { ...base, preview: 'bookmark', caret: s.from, bookmarkPos: insertAt + 1 },
  }
}

function closeMenu(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(linkMenuKey, { type: 'close' } satisfies LinkMenuMeta))
}

function navigate(view: EditorView, delta: number): void {
  const s = linkMenuKey.getState(view.state)
  if (!s?.active || s.confirmPending) return
  const index = (s.index + delta + ITEMS.length) % ITEMS.length
  const item = ITEMS[index]
  if (!item) return
  const res = previewTransaction(view.state, s, item.id)
  if (!res) return
  res.tr.setMeta(linkMenuKey, {
    type: 'set',
    state: { ...res.next, index },
  } satisfies LinkMenuMeta)
  view.dispatch(res.tr.scrollIntoView())
}

function confirm(view: EditorView): void {
  const s = linkMenuKey.getState(view.state)
  if (!s?.active || s.confirmPending) return
  if (s.preview !== 'url' && !s.metaDone) {
    view.dispatch(
      view.state.tr.setMeta(linkMenuKey, {
        type: 'set',
        state: { ...s, confirmPending: true },
      } satisfies LinkMenuMeta),
    )
    return
  }
  closeMenu(view)
  view.focus()
}

/** Escape: プレーンリンクに戻して閉じる（Notion の Dismiss 相当） */
function dismiss(view: EditorView): void {
  const s = linkMenuKey.getState(view.state)
  if (!s?.active) return
  const res = previewTransaction(view.state, s, 'url')
  const tr = res ? res.tr : view.state.tr
  tr.setMeta(linkMenuKey, { type: 'close' } satisfies LinkMenuMeta)
  view.dispatch(tr)
  view.focus()
}

function pickItem(view: EditorView, index: number): void {
  const s = linkMenuKey.getState(view.state)
  if (!s?.active || s.confirmPending) return
  const item = ITEMS[index]
  if (!item) return
  if (item.id !== s.preview) {
    const res = previewTransaction(view.state, s, item.id)
    if (!res) return
    res.tr.setMeta(linkMenuKey, {
      type: 'set',
      state: { ...res.next, index },
    } satisfies LinkMenuMeta)
    view.dispatch(res.tr.scrollIntoView())
  }
  confirm(view)
}

function metaArrived(view: EditorView, url: string, meta: LinkMetadata): void {
  if (view.isDestroyed) return
  const s = linkMenuKey.getState(view.state)
  // メニューが閉じた後に fetch が返ってきたら破棄（placeholder のまま確定済み）
  if (!s?.active || s.url !== url) return
  const tr = view.state.tr
  if (s.preview === 'mention') {
    tr.setNodeMarkup(s.from, null, {
      href: url,
      title: meta.title ?? url,
      favicon: meta.favicon,
    })
  } else if (s.preview === 'bookmark' && s.bookmarkPos !== null) {
    tr.setNodeMarkup(s.bookmarkPos, null, bookmarkAttrs(url, meta))
  }
  if (s.confirmPending) {
    tr.setMeta(linkMenuKey, { type: 'close' } satisfies LinkMenuMeta)
  } else {
    tr.setMeta(linkMenuKey, {
      type: 'set',
      state: { ...s, meta, metaDone: true },
    } satisfies LinkMenuMeta)
  }
  view.dispatch(tr)
  if (s.confirmPending) view.focus()
}

class LinkMenuView {
  private view: EditorView
  private fetchMeta: FetchLinkMetadata
  private menu: HTMLElement
  private fetchedUrl: string | null = null

  constructor(view: EditorView, fetchMeta: FetchLinkMetadata) {
    this.view = view
    this.fetchMeta = fetchMeta
    this.menu = createMenuOverlay(view)
  }

  update(view: EditorView): void {
    this.view = view
    const state = linkMenuKey.getState(view.state)
    if (!state?.active) {
      this.fetchedUrl = null
      this.menu.style.display = 'none'
      return
    }
    this.ensureFetch(state.url)
    this.menu.replaceChildren()
    const heading = document.createElement('div')
    heading.className = 'jb-slash-heading'
    heading.textContent = 'Paste as'
    this.menu.append(heading)
    ITEMS.forEach((item, i) => {
      const glyph = document.createElement('span')
      glyph.className = 'jb-glyph'
      glyph.dataset.kind = item.id
      const button = menuItemButton({
        icon: glyph,
        label: item.label,
        active: i === state.index,
        onPick: () => pickItem(this.view, i),
      })
      if (state.confirmPending && i === state.index) {
        const spinner = document.createElement('span')
        spinner.className = 'jb-linkmenu-spinner'
        button.append(spinner)
      }
      this.menu.append(button)
    })

    positionMenuAt(view, this.menu, state.from)
  }

  private ensureFetch(url: string): void {
    if (this.fetchedUrl === url) return
    this.fetchedUrl = url
    void this.fetchMeta(url).then(
      (meta) => metaArrived(this.view, url, meta ?? EMPTY_META),
      () => metaArrived(this.view, url, EMPTY_META),
    )
  }

  destroy(): void {
    this.menu.remove()
  }
}

// Notion の paste メニュー同様、↑↓で選んだ表現を doc に即時反映（ライブプレビュー）し、
// Enter は「表示中の状態をそのまま確定」するだけにする。メニュー表示中の doc 変更は
// すべて previewTransaction 経由（set meta 同梱）で行い、それ以外の doc 変更は
// id を振るだけのものを除いて「そのまま確定」として閉じる。
export function linkMenuPlugin(fetchLinkMetadata: FetchLinkMetadata): Plugin<LinkMenuState> {
  return new Plugin<LinkMenuState>({
    key: linkMenuKey,
    state: {
      init: (): LinkMenuState => ({ active: false }),
      apply(tr, value, _oldState, newState): LinkMenuState {
        const meta = tr.getMeta(linkMenuKey) as LinkMenuMeta | undefined
        if (meta?.type === 'open') {
          return {
            active: true,
            from: meta.from,
            url: meta.url,
            index: 0,
            preview: 'url',
            caret: meta.from + meta.url.length,
            bookmarkPos: null,
            extraParaPos: null,
            meta: null,
            metaDone: false,
            confirmPending: false,
          }
        }
        if (meta?.type === 'close') return { active: false }
        if (!value.active) return value
        if (meta?.type === 'set') return meta.state
        // メニュー由来でない doc 変更・カーソル移動は「そのまま確定」として閉じる。
        // id を振るだけの変更は位置を動かさないので、from などを mapping せずに開いたままにする
        if (tr.docChanged && !onlyWritesBlockIds(tr)) return { active: false }
        if (!newState.selection.empty || newState.selection.head !== value.caret) {
          return { active: false }
        }
        return value
      },
    },
    props: {
      handleKeyDown(view, event) {
        const state = linkMenuKey.getState(view.state)
        if (!state?.active) return false
        if (event.key === 'Escape') {
          dismiss(view)
          return true
        }
        const down = event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')
        const up = event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')
        if (down || up) {
          navigate(view, down ? 1 : -1)
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          confirm(view)
          return true
        }
        return false
      },
    },
    view: (view) => new LinkMenuView(view, fetchLinkMetadata),
  })
}
