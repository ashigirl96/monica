import { Extension, type Editor, type Range } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";

type SlashCommandItem = {
  title: string;
  detail: string;
  aliases: string[];
  command: (props: { editor: Editor; range: Range }) => void;
};

const slashCommandPluginKey = new PluginKey("editorSlashCommand");

function commandChain(editor: Editor, range: Range) {
  return editor.chain().focus().deleteRange(range);
}

const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    title: "Text",
    detail: "Plain paragraph",
    aliases: ["paragraph", "p"],
    command: ({ editor, range }) => commandChain(editor, range).setParagraph().run(),
  },
  {
    title: "Heading 1",
    detail: "Large section title",
    aliases: ["h1", "title"],
    command: ({ editor, range }) => commandChain(editor, range).setHeading({ level: 1 }).run(),
  },
  {
    title: "Heading 2",
    detail: "Medium section title",
    aliases: ["h2", "subtitle"],
    command: ({ editor, range }) => commandChain(editor, range).setHeading({ level: 2 }).run(),
  },
  {
    title: "Bulleted List",
    detail: "Simple bullets",
    aliases: ["bullet", "ul"],
    command: ({ editor, range }) => commandChain(editor, range).toggleBulletList().run(),
  },
  {
    title: "Numbered List",
    detail: "Ordered steps",
    aliases: ["ordered", "ol", "number"],
    command: ({ editor, range }) => commandChain(editor, range).toggleOrderedList().run(),
  },
  {
    title: "Task List",
    detail: "Checkboxes",
    aliases: ["todo", "check"],
    command: ({ editor, range }) => commandChain(editor, range).toggleTaskList().run(),
  },
  {
    title: "Quote",
    detail: "Callout text",
    aliases: ["blockquote"],
    command: ({ editor, range }) => commandChain(editor, range).toggleBlockquote().run(),
  },
  {
    title: "Code Block",
    detail: "Monospace block",
    aliases: ["code"],
    command: ({ editor, range }) => commandChain(editor, range).toggleCodeBlock().run(),
  },
  {
    title: "Divider",
    detail: "Horizontal rule",
    aliases: ["hr", "rule"],
    command: ({ editor, range }) => commandChain(editor, range).setHorizontalRule().run(),
  },
];

function filterCommands(query: string): SlashCommandItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((item) =>
    [item.title, item.detail, ...item.aliases].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}

function renderSlashMenu() {
  let element: HTMLDivElement | null = null;
  let unmount: (() => void) | null = null;
  let selectedIndex = 0;
  let propsRef: SuggestionProps<SlashCommandItem, SlashCommandItem> | null = null;

  const select = (index: number) => {
    const props = propsRef;
    if (!props) return;
    const item = props.items[index];
    if (!item) return;
    props.command(item);
  };

  const render = (props: SuggestionProps<SlashCommandItem, SlashCommandItem>) => {
    propsRef = props;
    if (!element) return;
    selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, props.items.length - 1)));
    element.replaceChildren(
      ...props.items.map((item, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `editor-slash-item${index === selectedIndex ? " is-selected" : ""}`;
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          select(index);
        });

        const title = document.createElement("span");
        title.className = "editor-slash-title";
        title.textContent = item.title;

        const detail = document.createElement("span");
        detail.className = "editor-slash-detail";
        detail.textContent = item.detail;

        button.append(title, detail);
        return button;
      }),
    );
  };

  return {
    onStart(props: SuggestionProps<SlashCommandItem, SlashCommandItem>) {
      element = document.createElement("div");
      element.className = "editor-slash-menu";
      selectedIndex = 0;
      render(props);
      unmount = props.mount(element);
    },
    onUpdate(props: SuggestionProps<SlashCommandItem, SlashCommandItem>) {
      render(props);
    },
    onKeyDown({ event }: SuggestionKeyDownProps) {
      const props = propsRef;
      if (!props) return false;

      if (event.key === "ArrowDown") {
        selectedIndex = (selectedIndex + 1) % Math.max(1, props.items.length);
        render(props);
        return true;
      }

      if (event.key === "ArrowUp") {
        selectedIndex =
          (selectedIndex - 1 + Math.max(1, props.items.length)) % Math.max(1, props.items.length);
        render(props);
        return true;
      }

      if (event.key === "Enter") {
        select(selectedIndex);
        return true;
      }

      return false;
    },
    onExit() {
      unmount?.();
      element = null;
      unmount = null;
      propsRef = null;
      selectedIndex = 0;
    },
  };
}

export const SlashCommand = Extension.create({
  name: "slashCommand",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashCommandItem, SlashCommandItem>({
        pluginKey: slashCommandPluginKey,
        editor: this.editor,
        char: "/",
        allowedPrefixes: null,
        items: ({ query }) => filterCommands(query),
        command: ({ editor, range, props }) => props.command({ editor, range }),
        render: renderSlashMenu,
      }),
    ];
  },
});
