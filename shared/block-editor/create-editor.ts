import { EditorState } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { Node as PMNode } from "@milkdown/kit/prose/model";
import { emptyDoc, schema } from "./schema";
import { editorKeymap } from "./keymap";
import { editorInputRules } from "./input-rules";
import { blockSelectionPlugin } from "./block-selection";
import { slashMenuPlugin } from "./slash-menu";
import { normalizerPlugin } from "./normalizer";
import { numberingPlugin, placeholderPlugin } from "./decorations";
import { dragDropPlugin } from "./drag-drop";
import { clipboardPlugin } from "./clipboard";
import { editorNodeViews } from "./node-views";
import { imeDebugPlugin } from "./debug-ime";

function docFromJSON(json: unknown): PMNode {
  if (json === null || json === undefined) return emptyDoc();
  try {
    return PMNode.fromJSON(schema, json);
  } catch {
    return emptyDoc();
  }
}

export function createBlockEditor(mount: HTMLElement, initialDoc: unknown): EditorView {
  const state = EditorState.create({
    doc: docFromJSON(initialDoc),
    // TODO.md §12.1: menu → block selection → 構造キー → inline → default の順
    plugins: [
      // 全 keystroke の logging + 全文 walk を伴うため dev 限定
      ...(import.meta.env.DEV ? [imeDebugPlugin()] : []),
      slashMenuPlugin(),
      blockSelectionPlugin(),
      ...editorKeymap(),
      editorInputRules(),
      placeholderPlugin(),
      numberingPlugin(),
      dragDropPlugin(),
      clipboardPlugin(),
      normalizerPlugin(),
    ],
  });
  return new EditorView(mount, {
    state,
    nodeViews: editorNodeViews(),
    attributes: { class: "jb-editor", spellcheck: "false" },
  });
}
