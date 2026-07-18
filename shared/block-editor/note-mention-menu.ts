import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { nodes } from "./schema";
import { getBlockContext } from "./context";
import { BLOCKS_MIME, pastedUrl } from "./clipboard";
import {
  createMenuOverlay,
  handleMenuNavKey,
  menuItemButton,
  positionMenuAt,
} from "./menu-overlay";
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
  let url: URL;
  try {
    // 相対 path は origin 基準で解決され、絶対 URL は自分の origin を保つ
    url = new URL(trimmed, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const match = /^\/notes\/([^/]+)\/?$/.exec(url.pathname);
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

/** query 変更後・新しい検索結果が届く前は前 query の items を捨てる。表示と選択の両方が
    これを通るので、stale な候補を Enter/Tab/クリックで誤挿入するのをまとめて防ぐ。 */
export function freshItems(state: NoteMentionMenuActiveState): NoteMentionItem[] {
  return state.loadedQuery === state.query ? state.items : [];
}

/** 表示・選択の対象リスト。query が内部ノート URL なら先頭に直接リンク候補を合成する */
function displayItems(state: NoteMentionMenuActiveState): DisplayItem[] {
  const items: DisplayItem[] = freshItems(state).map((item) => ({
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
    // 古い結果の破棄（stale ガード）は state.apply の query 照合に一元化されている
    this.search(query)
      .then((items) => {
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
        // query が変わったら選択位置を先頭へ戻す（新 query の先頭候補をハイライト）
        const index = query === value.query ? value.index : 0;
        return { ...value, pos, query, index };
      },
    },
    // `[[URL]]` の閉じ `]]` を検出して全体を mention に変換する。query は apply() が
    // transaction 単位で再計算するので、ここに置けばタイピング・paste・IME を問わず効く
    appendTransaction(_trs, _old, newState) {
      const state = noteMentionMenuKey.getState(newState);
      if (!state?.active || !state.query.endsWith("]]")) return null;
      const noteId = internalNoteId(state.query.slice(0, -2), window.location.origin);
      if (!noteId) return null;
      return insertNoteMentionTransaction(newState, state, noteId);
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (view.composing) return false;
        const state = noteMentionMenuKey.getState(view.state);
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
        const close = () =>
          view.dispatch(
            view.state.tr.setMeta(noteMentionMenuKey, {
              type: "close",
            } satisfies NoteMentionMenuMeta),
          );
        const items = displayItems(state);
        return handleMenuNavKey(event, state.index, {
          itemCount: items.length,
          onClose: close,
          onNav: (index) =>
            view.dispatch(
              view.state.tr.setMeta(noteMentionMenuKey, {
                type: "nav",
                index,
              } satisfies NoteMentionMenuMeta),
            ),
          onPick: () => {
            const item = items[Math.min(state.index, items.length - 1)];
            if (item) applyItem(view, item.noteId);
            else close();
          },
        });
      },
      // 内部ノート URL の paste は mention に自動変換する。この plugin ごと未登録
      // （desktop journal）なら handler が存在せず、clipboard 側の従来動作に落ちる
      handlePaste(view, event) {
        if (event.clipboardData?.getData(BLOCKS_MIME)) return false;
        const url = pastedUrl(event);
        if (!url) return false;
        const state = noteMentionMenuKey.getState(view.state);
        if (state?.active) {
          // メニュー中の URL paste は query の一部（link 化すると二重メニューになる）
          view.dispatch(view.state.tr.insertText(url));
          return true;
        }
        const sel = view.state.selection;
        if (!sel.empty) return false;
        const ctx = getBlockContext(sel.$from);
        if (!ctx || ctx.contentNode.type === nodes.codeBlock) return false;
        const noteId = internalNoteId(url, window.location.origin);
        if (!noteId) return false;
        view.dispatch(
          insertNoteMentionTransaction(view.state, { pos: sel.from }, noteId).scrollIntoView(),
        );
        return true;
      },
    },
    view: (view) => new NoteMentionMenuView(view, search),
  });
}
