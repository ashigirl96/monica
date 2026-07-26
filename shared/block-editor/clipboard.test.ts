/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import type { Transaction } from "@milkdown/kit/prose/state";
import { Slice } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { BLOCKS_MIME, clipboardPlugin, serializeBlocksPayload } from "./clipboard";
import { blockSelectionPlugin } from "./block-selection";
import { selectBlocks } from "./selection-state";
import { block, contentPos, docOf, heading, para } from "./test-fixtures";

/** handlePaste を stub view で直接呼び、dispatch された transaction を適用した state を返す */
function paste(state: EditorState, payload: string): EditorState {
  const plugin = clipboardPlugin();
  let dispatched: Transaction | undefined;
  const view = {
    state,
    dispatch: (tr: Transaction) => {
      dispatched = tr;
    },
  } as unknown as EditorView;
  const event = {
    clipboardData: { getData: (type: string) => (type === BLOCKS_MIME ? payload : "") },
  } as unknown as ClipboardEvent;
  const handled = plugin.props.handlePaste!.call(plugin, view, event, Slice.empty);
  expect(handled).toBe(true);
  expect(dispatched).toBeDefined();
  return state.apply(dispatched!);
}

describe("handlePaste と折りたたみ", () => {
  const payload = serializeBlocksPayload([block("X", para("x"))]);

  test("collapsed heading 上での paste は貼り先を隠す畳みを開く", () => {
    const doc = docOf(block("H", heading("A", 2, true)), block("P", para("1")));
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, "H", "end")),
    });
    const after = paste(state, payload);
    const group = after.doc.child(0);
    expect(group.child(0).child(0).attrs.collapsed).toBe(false);
    expect([...Array(group.childCount).keys()].map((i) => group.child(i).textContent)).toEqual([
      "A",
      "x",
      "1",
    ]);
  });

  test("collapsed heading の block 選択への paste も同様に開く", () => {
    const doc = docOf(block("H", heading("A", 2, true)), block("P", para("1")));
    const base = EditorState.create({ doc, plugins: [blockSelectionPlugin()] });
    const state = base.apply(selectBlocks(base.tr, "H", "H"));
    const after = paste(state, payload);
    const group = after.doc.child(0);
    expect(group.child(0).child(0).attrs.collapsed).toBe(false);
    expect(group.child(1).textContent).toBe("x");
  });

  test("畳まれていない貼り先では何も開かない（attrs 不変）", () => {
    const doc = docOf(block("H", heading("A", 2)), block("P", para("1")));
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, "H", "end")),
    });
    const after = paste(state, payload);
    expect(after.doc.child(0).child(0).child(0).attrs.collapsed).toBe(false);
    expect(after.doc.child(0).childCount).toBe(3);
  });
});
