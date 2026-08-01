/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { block, contentPos, docOf, para } from "./test-fixtures";
import { slashMenuPlugin } from "./slash-menu";
import { slashKey } from "./menu-keys";

describe("slashMenuPlugin の state 追従", () => {
  const plugin = slashMenuPlugin();

  /** `/` 入力直後・メニューが開いた状態。pos は `/` の位置 */
  function openedState(): { state: EditorState; pos: number } {
    const doc = docOf(block("a", para("/")));
    const pos = contentPos(doc, "a", 0);
    const base = EditorState.create({
      doc,
      plugins: [plugin],
      selection: TextSelection.create(doc, pos + 1),
    });
    const state = base.apply(base.tr.setMeta(slashKey, { type: "open", pos }));
    return { state, pos };
  }

  function menuState(state: EditorState) {
    return slashKey.getState(state)!;
  }

  test("通常タイピングで query が追従する", () => {
    const { state } = openedState();
    const next = state.apply(state.tr.insertText("no"));
    expect(menuState(next)).toMatchObject({ active: true, query: "no" });
  });

  test("IME 変換中の文節選択（query 内の非空選択）でも閉じない", () => {
    const { state, pos } = openedState();
    const tr = state.tr.insertText("めも");
    tr.setSelection(TextSelection.create(tr.doc, pos + 1, pos + 3));
    const next = state.apply(tr);
    expect(menuState(next)).toMatchObject({ active: true, query: "めも" });
  });

  test("選択が / を跨いだら閉じる", () => {
    const { state, pos } = openedState();
    const tr = state.tr.insertText("foo");
    tr.setSelection(TextSelection.create(tr.doc, pos, pos + 2));
    const next = state.apply(tr);
    expect(menuState(next)).toEqual({ active: false });
  });
});
