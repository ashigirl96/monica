import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { nodes } from "./schema";
import { getBlockContext } from "./context";
import { createMenuOverlay, menuItemButton, positionMenuAt } from "./menu-overlay";
import { noteMentionMenuKey, slashKey } from "./menu-keys";

export type NoteMentionItem = {
  id: string;
  displayName: string;
  /** dropdown のサブラベル（ノート本文の先頭行） */
  preview: string | null;
};

export type SearchNoteMentions = (query: string) => Promise<NoteMentionItem[]>;

export type NoteMentionMenuActiveState = {
  active: true;
  /** 最初の `[` の位置 */
  pos: number;
  query: string;
  index: number;
  /** 検索結果。query より遅れて到着するので loadedQuery で鮮度を判定する */
  items: NoteMentionItem[];
  loadedQuery: string | null;
};

export type NoteMentionMenuState = { active: false } | NoteMentionMenuActiveState;

type NoteMentionMenuMeta =
  | { type: "open"; pos: number }
  | { type: "close" }
  | { type: "nav"; index: number }
  | { type: "results"; query: string; items: NoteMentionItem[] };

/** 内部ノート URL（相対 `/notes/<id>` または origin 一致の絶対 URL）から id セグメントを
    緩く抜き出す。id の正規形検証はここでは行わず Rust 側の resolve に委ねる
    （存在しない id は 404 → dangling 表示に落ちるだけ）。 */
export function internalNoteId(text: string, origin: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let path: string;
  if (trimmed.startsWith("/")) {
    path = trimmed.split(/[?#]/, 1)[0];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.origin !== origin) return null;
    path = url.pathname;
  }
  const match = /^\/notes\/([^/]+)\/?$/.exec(path);
  return match ? decodeURIComponent(match[1]) : null;
}

/** `[[query` を削除して noteMention を挿入し、カーソルを直後へ置く */
export function insertNoteMentionTransaction(
  state: EditorState,
  menu: Pick<NoteMentionMenuActiveState, "pos">,
  noteId: string,
): Transaction {
  const head = state.selection.head;
  const tr = state.tr.delete(menu.pos, head);
  const mention = nodes.noteMention.create({ noteId });
  tr.insert(menu.pos, mention);
  tr.setSelection(TextSelection.create(tr.doc, menu.pos + mention.nodeSize));
  tr.setMeta(noteMentionMenuKey, { type: "close" } satisfies NoteMentionMenuMeta);
  return tr;
}

type DisplayItem = { noteId: string; label: string; hint: string | null };

/** 表示・選択の対象リスト。query が内部ノート URL なら先頭に直接リンク候補を合成する */
function displayItems(state: NoteMentionMenuActiveState): DisplayItem[] {
  const items: DisplayItem[] = state.items.map((item) => ({
    noteId: item.id,
    label: item.displayName,
    hint: item.preview,
  }));
  const urlNoteId = internalNoteId(state.query, window.location.origin);
  if (urlNoteId) items.unshift({ noteId: urlNoteId, label: "Link to note", hint: urlNoteId });
  return items;
}

function applyItem(view: EditorView, noteId: string): void {
  const state = noteMentionMenuKey.getState(view.state);
  if (!state?.active) return;
  view.dispatch(insertNoteMentionTransaction(view.state, state, noteId).scrollIntoView());
  view.focus();
}

class NoteMentionMenuView {
  private menu: HTMLElement;
  private requestedQuery: string | null = null;

  constructor(
    private view: EditorView,
    private search: SearchNoteMentions,
  ) {
    this.menu = createMenuOverlay(view);
  }

  update(view: EditorView): void {
    this.view = view;
    const state = noteMentionMenuKey.getState(view.state);
    if (!state?.active) {
      this.menu.style.display = "none";
      this.requestedQuery = null;
      return;
    }
    if (state.query !== this.requestedQuery) {
      this.requestedQuery = state.query;
      this.fetch(state.query);
    }
    this.render(state);
  }

  private fetch(query: string): void {
    this.search(query)
      .then((items) => {
        // 遅れて解決した古い結果を反映しない（apply 側の query 照合と二重の防衛）
        const current = noteMentionMenuKey.getState(this.view.state);
        if (!current?.active || current.query !== query) return;
        this.view.dispatch(
          this.view.state.tr.setMeta(noteMentionMenuKey, {
            type: "results",
            query,
            items,
          } satisfies NoteMentionMenuMeta),
        );
      })
      .catch(() => {});
  }

  private render(state: NoteMentionMenuActiveState): void {
    const items = displayItems(state);
    this.menu.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "jb-slash-empty";
      empty.textContent = state.loadedQuery === state.query ? "No results" : "Searching…";
      this.menu.append(empty);
    } else {
      const heading = document.createElement("div");
      heading.className = "jb-slash-heading";
      heading.textContent = "Link to note";
      this.menu.append(heading);
    }
    items.forEach((item, i) => {
      const glyph = document.createElement("span");
      glyph.className = "jb-glyph";
      glyph.dataset.kind = "mention";
      this.menu.append(
        menuItemButton({
          icon: glyph,
          label: item.label,
          hint: item.hint ?? undefined,
          active: i === state.index,
          onPick: () => applyItem(this.view, item.noteId),
        }),
      );
    });
    positionMenuAt(this.view, this.menu, state.pos);
  }

  destroy(): void {
    this.menu.remove();
  }
}

export function noteMentionMenuPlugin(search: SearchNoteMentions): Plugin<NoteMentionMenuState> {
  return new Plugin<NoteMentionMenuState>({
    key: noteMentionMenuKey,
    state: {
      init: (): NoteMentionMenuState => ({ active: false }),
      apply(tr, value, _oldState, newState): NoteMentionMenuState {
        const meta = tr.getMeta(noteMentionMenuKey) as NoteMentionMenuMeta | undefined;
        if (meta?.type === "open") {
          return { active: true, pos: meta.pos, query: "", index: 0, items: [], loadedQuery: null };
        }
        if (meta?.type === "close") return { active: false };
        if (!value.active) return value;
        if (meta?.type === "nav") return { ...value, index: meta.index };
        if (meta?.type === "results") {
          if (meta.query !== value.query) return value;
          return {
            ...value,
            items: meta.items,
            loadedQuery: meta.query,
            index: Math.min(value.index, Math.max(meta.items.length - 1, 0)),
          };
        }
        const pos = tr.mapping.map(value.pos);
        const head = newState.selection.head;
        if (!newState.selection.empty) return { active: false };
        const $pos = newState.doc.resolve(pos);
        const $head = newState.selection.$head;
        if ($pos.parent !== $head.parent || head < pos + 2) return { active: false };
        if (newState.doc.textBetween(pos, pos + 2) !== "[[") return { active: false };
        const query = newState.doc.textBetween(pos + 2, head);
        return { ...value, pos, query };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (view.composing) return false;
        const state = noteMentionMenuKey.getState(view.state);
        // `[[URL]]` の直接入力: 閉じ `]]` の 2 文字目で全体を mention に変換する
        // （1 文字目の `]` は通常挿入され query の末尾に載っている）
        if (state?.active && text === "]" && state.query.endsWith("]")) {
          const noteId = internalNoteId(state.query.slice(0, -1), window.location.origin);
          if (noteId) {
            applyItem(view, noteId);
            return true;
          }
          return false;
        }
        if (text !== "[" || state?.active) return false;
        if (slashKey.getState(view.state)?.active) return false;
        const $from = view.state.doc.resolve(from);
        // 直前の 1 文字が同じ textblock 内の `[` であること（block 境界は textBetween が "" を返す）
        if (from - 1 < $from.start()) return false;
        if (view.state.doc.textBetween(from - 1, from) !== "[") return false;
        const ctx = getBlockContext($from);
        if (!ctx) return false;
        const type = ctx.contentNode.type;
        if (type === nodes.codeBlock || type === nodes.divider) return false;
        const tr = view.state.tr.insertText("[", from, to);
        tr.setMeta(noteMentionMenuKey, {
          type: "open",
          pos: from - 1,
        } satisfies NoteMentionMenuMeta);
        view.dispatch(tr);
        return true;
      },
      handleKeyDown(view, event) {
        const state = noteMentionMenuKey.getState(view.state);
        if (!state?.active) return false;
        if (event.key === "Escape") {
          view.dispatch(
            view.state.tr.setMeta(noteMentionMenuKey, {
              type: "close",
            } satisfies NoteMentionMenuMeta),
          );
          return true;
        }
        const items = displayItems(state);
        const down = event.key === "ArrowDown" || (event.ctrlKey && event.key === "n");
        const up = event.key === "ArrowUp" || (event.ctrlKey && event.key === "p");
        if (down || up) {
          if (items.length === 0) return true;
          const delta = down ? 1 : -1;
          const index = (state.index + delta + items.length) % items.length;
          view.dispatch(
            view.state.tr.setMeta(noteMentionMenuKey, {
              type: "nav",
              index,
            } satisfies NoteMentionMenuMeta),
          );
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[Math.min(state.index, items.length - 1)];
          if (item) applyItem(view, item.noteId);
          else
            view.dispatch(
              view.state.tr.setMeta(noteMentionMenuKey, {
                type: "close",
              } satisfies NoteMentionMenuMeta),
            );
          return true;
        }
        return false;
      },
    },
    view: (view) => new NoteMentionMenuView(view, search),
  });
}
