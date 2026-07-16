import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Attrs, NodeType } from "@milkdown/kit/prose/model";
import { emptyParagraphContainer, nodes } from "./schema";
import { getBlockContext } from "./context";

type SlashState = { active: false } | { active: true; pos: number; query: string; index: number };

type SlashMeta = { type: "open"; pos: number } | { type: "close" } | { type: "nav"; index: number };

const slashKey = new PluginKey<SlashState>("journalSlashMenu");

type SlashItem = {
  id: string;
  label: string;
  icon: string;
  aliases: string[];
  nodeType: NodeType;
  attrs: Attrs | null;
};

const ITEMS: SlashItem[] = [
  {
    id: "text",
    label: "Text",
    icon: "T",
    aliases: ["paragraph", "plain"],
    nodeType: nodes.paragraph,
    attrs: null,
  },
  {
    id: "h2",
    label: "Heading",
    icon: "H",
    aliases: ["h1", "h2", "heading", "##"],
    nodeType: nodes.heading,
    attrs: { level: 2 },
  },
  {
    id: "h3",
    label: "Subheading",
    icon: "h",
    aliases: ["h3", "sub", "###"],
    nodeType: nodes.heading,
    attrs: { level: 3 },
  },
  {
    id: "todo",
    label: "To-do list",
    icon: "☑",
    aliases: ["todo", "task", "checkbox"],
    nodeType: nodes.todo,
    attrs: { checked: false },
  },
  {
    id: "bullet",
    label: "Bulleted list",
    icon: "•",
    aliases: ["bullet", "ul", "unordered"],
    nodeType: nodes.bullet,
    attrs: null,
  },
  {
    id: "numbered",
    label: "Numbered list",
    icon: "1.",
    aliases: ["numbered", "ol", "ordered"],
    nodeType: nodes.numbered,
    attrs: { style: "decimal" },
  },
  {
    id: "toggle",
    label: "Toggle list",
    icon: "▸",
    aliases: ["toggle", "collapse"],
    nodeType: nodes.toggle,
    attrs: { open: true },
  },
  {
    id: "quote",
    label: "Quote",
    icon: "❝",
    aliases: ["quote", "blockquote"],
    nodeType: nodes.quote,
    attrs: null,
  },
  {
    id: "callout",
    label: "Callout",
    icon: "💡",
    aliases: ["callout", "note", "info", "tip"],
    nodeType: nodes.callout,
    attrs: null,
  },
  {
    id: "code",
    label: "Code",
    icon: "{}",
    aliases: ["code", "codeblock", "snippet"],
    nodeType: nodes.codeBlock,
    attrs: null,
  },
  {
    id: "divider",
    label: "Divider",
    icon: "—",
    aliases: ["divider", "hr", "separator"],
    nodeType: nodes.divider,
    attrs: null,
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
        ? item.nodeType.create(item.attrs, content.content.size > 0 ? content.content : undefined)
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
      heading.textContent = "Basic blocks";
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
      icon.textContent = item.icon;
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
        if (!state?.active) return false;
        const items = filterItems(state.query);
        if (event.key === "Escape") {
          view.dispatch(view.state.tr.setMeta(slashKey, { type: "close" } satisfies SlashMeta));
          return true;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (items.length === 0) return true;
          const delta = event.key === "ArrowDown" ? 1 : -1;
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
