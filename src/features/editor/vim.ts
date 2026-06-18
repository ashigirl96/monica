import { Extension, type Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, Selection } from "@tiptap/pm/state";
import {
  createInitialMinimalVimState,
  isHandledVimKey,
  isPrintableKey,
  resolveMinimalVimKey,
  shouldStopVimPropagation,
  type MinimalVimState,
  type VimAction,
  type VimMode,
} from "@/features/editor/vim-logic";

type MinimalVimOptions = {
  onModeChange?: (mode: VimMode) => void;
};

type TextBlockRange = {
  pos: number;
  from: number;
  to: number;
  nodeSize: number;
};

function textBlocks(doc: ProseMirrorNode): TextBlockRange[] {
  const ranges: TextBlockRange[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      ranges.push({ pos, from: pos + 1, to: pos + node.nodeSize - 1, nodeSize: node.nodeSize });
    }
  });
  return ranges;
}

function currentTextBlock(doc: ProseMirrorNode, position: number): TextBlockRange | null {
  return (
    textBlocks(doc).find(
      (block) => position >= block.pos && position <= block.pos + block.nodeSize,
    ) ?? null
  );
}

function setNearSelection(editor: Editor, position: number, bias: 1 | -1): boolean {
  const { state, view } = editor;
  const resolved = state.doc.resolve(Math.max(0, Math.min(position, state.doc.content.size)));
  view.dispatch(state.tr.setSelection(Selection.near(resolved, bias)).scrollIntoView());
  return true;
}

function moveBy(editor: Editor, delta: number): boolean {
  return setNearSelection(editor, editor.state.selection.head + delta, delta > 0 ? 1 : -1);
}

function moveBlock(editor: Editor, delta: 1 | -1): boolean {
  const blocks = textBlocks(editor.state.doc);
  if (blocks.length === 0) return false;
  const currentIndex = Math.max(
    0,
    blocks.findIndex(
      (block) =>
        editor.state.selection.head >= block.pos &&
        editor.state.selection.head <= block.pos + block.nodeSize,
    ),
  );
  const target = blocks[Math.max(0, Math.min(blocks.length - 1, currentIndex + delta))];
  return setNearSelection(editor, target.from, delta);
}

function deleteCurrentBlock(editor: Editor): boolean {
  const { state, view } = editor;
  const block = currentTextBlock(state.doc, state.selection.head);
  if (!block) return false;

  if (textBlocks(state.doc).length <= 1) {
    return editor.commands.clearContent();
  }

  const tr = state.tr.delete(block.pos, block.pos + block.nodeSize);
  const selection = Selection.near(
    tr.doc.resolve(Math.max(0, Math.min(block.pos, tr.doc.content.size))),
    -1,
  );
  view.dispatch(tr.setSelection(selection).scrollIntoView());
  return true;
}

function runAction(editor: Editor, action: VimAction): boolean {
  switch (action) {
    case "moveLeft":
      return moveBy(editor, -1);
    case "moveRight":
      return moveBy(editor, 1);
    case "moveRightAndInsert":
      moveBy(editor, 1);
      editor.commands.focus();
      return true;
    case "moveNextBlock":
      return moveBlock(editor, 1);
    case "movePreviousBlock":
      return moveBlock(editor, -1);
    case "deleteBlock":
      return deleteCurrentBlock(editor);
    case "enterInsert":
    case "enterNormal":
    case "blockInput":
    case "none":
      editor.commands.focus();
      return true;
  }
}

export function createMinimalVimExtension(onModeChange?: (mode: VimMode) => void) {
  return Extension.create<MinimalVimOptions, MinimalVimState>({
    name: "minimalVim",
    priority: 1000,

    addOptions() {
      return { onModeChange };
    },

    addStorage() {
      return createInitialMinimalVimState();
    },

    addKeyboardShortcuts() {
      const handle = (key: string) => {
        const previousMode = this.storage.mode;
        const resolution = resolveMinimalVimKey(this.storage, key);
        if (!resolution.handled) return false;

        this.storage.mode = resolution.state.mode;
        this.storage.pending = resolution.state.pending;
        if (previousMode !== this.storage.mode) {
          this.options.onModeChange?.(this.storage.mode);
        }
        return runAction(this.editor, resolution.action);
      };

      return {
        Escape: () => handle("Escape"),
        i: () => handle("i"),
        a: () => handle("a"),
        h: () => handle("h"),
        j: () => handle("j"),
        k: () => handle("k"),
        l: () => handle("l"),
        d: () => handle("d"),
      };
    },

    addProseMirrorPlugins() {
      const storage = () => this.storage;
      return [
        new Plugin({
          props: {
            handleKeyDown(_view, event) {
              const current = storage();
              if (shouldStopVimPropagation(current, event.key)) {
                event.stopPropagation();
              }

              if (
                current.mode === "normal" &&
                isPrintableKey(event.key) &&
                !isHandledVimKey(event.key)
              ) {
                const resolution = resolveMinimalVimKey(current, event.key);
                current.mode = resolution.state.mode;
                current.pending = resolution.state.pending;
                event.preventDefault();
                return true;
              }

              return false;
            },
            handleTextInput() {
              return storage().mode === "normal";
            },
            handlePaste() {
              return storage().mode === "normal";
            },
          },
        }),
      ];
    },
  });
}
