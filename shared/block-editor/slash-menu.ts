import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Attrs, NodeType } from "@milkdown/kit/prose/model";
import { emptyParagraphContainer, nodes } from "./schema";
import { getBlockContext } from "./context";
import { inlineToPlainText } from "./commands";

type SlashState = { active: false } | { active: true; pos: number; query: string; index: number };

type SlashMeta = { type: "open"; pos: number } | { type: "close" } | { type: "nav"; index: number };

const slashKey = new PluginKey<SlashState>("journalSlashMenu");

type SlashItem = {
  id: string;
  label: string;
  /* .jb-glyph の data-kind（CSS の mask アイコンに対応） */
  icon: string;
  aliases: string[];
  nodeType: NodeType;
  attrs: Attrs | null;
};

const ITEMS: SlashItem[] = [
  {
    id: "callout-note",
    label: "Note",
    icon: "note",
    aliases: ["note", "callout", "info"],
    nodeType: nodes.callout,
    attrs: { kind: "note" },
  },
  {
    id: "callout-tips",
    label: "Tips",
    icon: "tips",
    aliases: ["tips", "tip", "hint"],
    nodeType: nodes.callout,
    attrs: { kind: "tips" },
  },
  {
    id: "callout-danger",
    label: "Danger",
    icon: "danger",
    aliases: ["danger", "warning", "caution"],
    nodeType: nodes.callout,
    attrs: { kind: "danger" },
  },
  {
    id: "callout-question",
    label: "Question",
    icon: "question",
    aliases: ["question", "faq", "help"],
    nodeType: nodes.callout,
    attrs: { kind: "question" },
  },
  {
    id: "callout-example",
    label: "Example",
    icon: "example",
    aliases: ["example", "sample"],
    nodeType: nodes.callout,
    attrs: { kind: "example" },
  },
];

function filterItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return ITEMS;
  return ITEMS.filter(
    (item) =>
      item.label.toLowerCase().includes(q) || item.aliases.some((alias) => alias.includes(q)),
  );
}

// slash 文字と query の削除、block 変換を 1 Transaction で行う（TODO.md §9.1）
function applyItem(view: EditorView, item: SlashItem): void {
  const state = slashKey.getState(view.state);
  if (!state?.active) return;
  const head = view.state.selection.head;
  const tr = view.state.tr.delete(state.pos, head);
  const ctx = getBlockContext(tr.doc.resolve(state.pos));
  if (!ctx) return;
  const content = ctx.contentNode;
  const newContent =
    item.nodeType === nodes.divider
      ? item.nodeType.create()
      : item.nodeType === nodes.codeBlock
        ? // codeBlock は marks 不可・text* のみなので inline を平文化する
          item.nodeType.create(item.attrs, inlineToPlainText(content))
        : item.nodeType.create(item.attrs, content.content);
  tr.replaceWith(ctx.contentPos, ctx.contentPos + content.nodeSize, newContent);
  if (item.nodeType === nodes.divider) {
    // divider はカーソルを持てないので直後に空 paragraph を作って移る
    const container = tr.doc.nodeAt(ctx.containerPos);
    if (container) {
      const at = ctx.containerPos + container.nodeSize;
      tr.insert(at, emptyParagraphContainer());
      tr.setSelection(TextSelection.create(tr.doc, at + 2));
    }
  } else if (newContent.inlineContent) {
    // replaceWith で潰れたカーソルを変換後 content 内の同 offset へ張り直す
    const offset = Math.min(Math.max(state.pos - (ctx.contentPos + 1), 0), newContent.content.size);
    tr.setSelection(TextSelection.create(tr.doc, ctx.contentPos + 1 + offset));
  }
  tr.setMeta(slashKey, { type: "close" } satisfies SlashMeta);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

class SlashMenuView {
  private menu: HTMLElement;

  constructor(private view: EditorView) {
    this.menu = document.createElement("div");
    this.menu.className = "jb-slash-menu";
    this.menu.style.display = "none";
    this.menu.setAttribute("role", "listbox");
    view.dom.parentElement?.append(this.menu);
  }

  update(view: EditorView): void {
    this.view = view;
    const state = slashKey.getState(view.state);
    if (!state?.active) {
      this.menu.style.display = "none";
      return;
    }
    const items = filterItems(state.query);
    this.menu.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "jb-slash-empty";
      empty.textContent = "No results";
      this.menu.append(empty);
    } else {
      const heading = document.createElement("div");
      heading.className = "jb-slash-heading";
      heading.textContent = "Callout";
      this.menu.append(heading);
    }
    items.forEach((item, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "jb-slash-item";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(i === state.index));
      if (i === state.index) button.classList.add("jb-slash-item-active");
      const icon = document.createElement("span");
      icon.className = "jb-slash-icon";
      const glyph = document.createElement("span");
      glyph.className = "jb-glyph";
      glyph.dataset.kind = item.icon;
      icon.append(glyph);
      const label = document.createElement("span");
      label.className = "jb-slash-label";
      label.textContent = item.label;
      button.append(icon, label);
      button.addEventListener("mousedown", (e) => e.preventDefault());
      button.addEventListener("click", () => applyItem(this.view, item));
      this.menu.append(button);
    });

    // §9.1: coordsAtPos で editor 外 overlay を配置（CSS zoom は比率で補正）
    const wrapper = view.dom.parentElement;
    if (!wrapper) return;
    const coords = view.coordsAtPos(state.pos);
    const wrapperRect = wrapper.getBoundingClientRect();
    const scale = wrapper.offsetWidth > 0 ? wrapperRect.width / wrapper.offsetWidth : 1;
    this.menu.style.display = "block";
    this.menu.style.left = `${(coords.left - wrapperRect.left) / scale}px`;
    this.menu.style.top = `${(coords.bottom - wrapperRect.top) / scale + 4}px`;
  }

  destroy(): void {
    this.menu.remove();
  }
}

export function slashMenuPlugin(): Plugin<SlashState> {
  return new Plugin<SlashState>({
    key: slashKey,
    state: {
      init: (): SlashState => ({ active: false }),
      apply(tr, value, _oldState, newState): SlashState {
        const meta = tr.getMeta(slashKey) as SlashMeta | undefined;
        if (meta?.type === "open") return { active: true, pos: meta.pos, query: "", index: 0 };
        if (meta?.type === "close") return { active: false };
        if (!value.active) return value;
        if (meta?.type === "nav") return { ...value, index: meta.index };
        const pos = tr.mapping.map(value.pos);
        const head = newState.selection.head;
        if (!newState.selection.empty) return { active: false };
        const $pos = newState.doc.resolve(pos);
        const $head = newState.selection.$head;
        if ($pos.parent !== $head.parent || head <= pos) return { active: false };
        if (newState.doc.textBetween(pos, pos + 1) !== "/") return { active: false };
        const query = newState.doc.textBetween(pos + 1, head);
        return { active: true, pos, query, index: value.index };
      },
    },
    props: {
      // §6.3/§13.1: composition 中は trigger しない
      handleTextInput(view, from, to, text) {
        if (text !== "/" || view.composing) return false;
        const state = slashKey.getState(view.state);
        if (state?.active) return false;
        const ctx = getBlockContext(view.state.doc.resolve(from));
        if (!ctx) return false;
        const type = ctx.contentNode.type;
        if (type === nodes.codeBlock || type === nodes.divider) return false;
        const tr = view.state.tr.insertText("/", from, to);
        tr.setMeta(slashKey, { type: "open", pos: from } satisfies SlashMeta);
        view.dispatch(tr);
        return true;
      },
      // §12.1: menu が開いている間は menu 側がキーを処理する
      handleKeyDown(view, event) {
        const state = slashKey.getState(view.state);
        if (!state?.active) {
          // Cmd-J でメニューを開く（"/" を挿入して通常のトリガー経路に乗せる）
          if (
            event.key === "j" &&
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey
          ) {
            const sel = view.state.selection;
            if (!sel.empty) return false;
            const ctx = getBlockContext(sel.$from);
            if (!ctx) return false;
            const type = ctx.contentNode.type;
            if (type === nodes.codeBlock || type === nodes.divider) return false;
            const tr = view.state.tr.insertText("/", sel.from);
            tr.setMeta(slashKey, { type: "open", pos: sel.from } satisfies SlashMeta);
            view.dispatch(tr);
            return true;
          }
          return false;
        }
        const items = filterItems(state.query);
        if (event.key === "Escape") {
          view.dispatch(view.state.tr.setMeta(slashKey, { type: "close" } satisfies SlashMeta));
          return true;
        }
        const down = event.key === "ArrowDown" || (event.ctrlKey && event.key === "n");
        const up = event.key === "ArrowUp" || (event.ctrlKey && event.key === "p");
        if (down || up) {
          if (items.length === 0) return true;
          const delta = down ? 1 : -1;
          const index = (state.index + delta + items.length) % items.length;
          view.dispatch(
            view.state.tr.setMeta(slashKey, { type: "nav", index } satisfies SlashMeta),
          );
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[Math.min(state.index, items.length - 1)];
          if (item) applyItem(view, item);
          else
            view.dispatch(view.state.tr.setMeta(slashKey, { type: "close" } satisfies SlashMeta));
          return true;
        }
        return false;
      },
    },
    view: (view) => new SlashMenuView(view),
  });
}
