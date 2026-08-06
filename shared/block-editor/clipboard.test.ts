/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import type { Transaction } from "@milkdown/kit/prose/state";
import { Slice } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  BLOCKS_MIME,
  clipboardPlugin,
  containersFromDocJson,
  serializeBlocksPayload,
} from "./clipboard";
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

/** from_markdown が返す形の doc JSON を組む（blockContainer は attrs なし） */
function mdDocJson(...contents: unknown[]): unknown {
  return {
    type: "doc",
    content: [
      {
        type: "blockGroup",
        content: contents.map((content) => ({ type: "blockContainer", content: [content] })),
      },
    ],
  };
}

/** markdown paste（text/plain のみ）を stub view で通し、async 変換の完了後の state を返す */
async function pasteMarkdown(
  state: EditorState,
  text: string,
  parseMarkdown: (markdown: string) => Promise<unknown>,
): Promise<EditorState> {
  const plugin = clipboardPlugin({ parseMarkdown });
  const holder = { state };
  const view = {
    isDestroyed: false,
    get state() {
      return holder.state;
    },
    dispatch: (tr: Transaction) => {
      holder.state = holder.state.apply(tr);
    },
  } as unknown as EditorView;
  const event = {
    clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") },
  } as unknown as ClipboardEvent;
  const handled = plugin.props.handlePaste!.call(plugin, view, event, Slice.empty);
  expect(handled).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return holder.state;
}

describe("markdown paste", () => {
  test("空 paragraph 上の `### hoge` は heading block に置き換わる", async () => {
    const doc = docOf(block("P", para()));
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, "P", "start")),
    });
    const parsed = mdDocJson({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "hoge" }],
    });
    const after = await pasteMarkdown(state, "### hoge", () => Promise.resolve(parsed));
    const group = after.doc.child(0);
    expect(group.childCount).toBe(1);
    const content = group.child(0).child(0);
    expect(content.type).toBe(after.schema.nodes.heading);
    expect(content.attrs.level).toBe(3);
    expect(content.textContent).toBe("hoge");
    expect(group.child(0).attrs.id).not.toBeNull();
  });

  test("単一 paragraph は block を割らずカーソル位置へ inline 挿入する", async () => {
    const doc = docOf(block("P", para("ab")));
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, "P", 1)),
    });
    const parsed = mdDocJson({
      type: "paragraph",
      content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }],
    });
    const after = await pasteMarkdown(state, "**bold**", () => Promise.resolve(parsed));
    const group = after.doc.child(0);
    expect(group.childCount).toBe(1);
    expect(group.child(0).child(0).textContent).toBe("aboldb");
    expect(
      group
        .child(0)
        .child(0)
        .child(1)
        .marks.map((m) => m.type.name),
    ).toEqual(["bold"]);
  });

  test("複数 block はカーソル block の直後に挿入される", async () => {
    const doc = docOf(block("P", para("1")));
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, "P", "end")),
    });
    const parsed = mdDocJson(
      { type: "bullet", content: [{ type: "text", text: "a" }] },
      { type: "bullet", content: [{ type: "text", text: "b" }] },
    );
    const after = await pasteMarkdown(state, "- a\n- b", () => Promise.resolve(parsed));
    const group = after.doc.child(0);
    expect([...Array(group.childCount).keys()].map((i) => group.child(i).textContent)).toEqual([
      "1",
      "a",
      "b",
    ]);
  });

  test("変換に失敗したら素のテキスト挿入に縮退する", async () => {
    const doc = docOf(block("P", para("x")));
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, "P", "end")),
    });
    const after = await pasteMarkdown(state, "## raw", () => Promise.reject(new Error("down")));
    expect(after.doc.child(0).child(0).textContent).toBe("x## raw");
  });

  test("markdown として空になる paste は素のテキストで入れる", async () => {
    const doc = docOf(block("P", para("ab")));
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, "P", 1)),
    });
    const after = await pasteMarkdown(state, "  ", () => Promise.resolve(mdDocJson()));
    expect(after.doc.child(0).child(0).textContent).toBe("a  b");
  });

  test("containersFromDocJson は doc 形でない JSON を弾く", () => {
    expect(containersFromDocJson({ type: "paragraph" })).toBeNull();
    expect(containersFromDocJson(null)).toBeNull();
    expect(containersFromDocJson(mdDocJson())).toEqual([]);
  });
});
