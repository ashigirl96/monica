/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { block, cellPositions, contentPos, docOf, para, tableOf } from "./test-fixtures";
import { TABLE_MENU_ITEMS, tableMenuPlugin } from "./table-menu";
import { tableMenuKey } from "./menu-keys";

describe("tableMenuPlugin の state 追従", () => {
  const plugin = tableMenuPlugin();

  const doc = () =>
    docOf(
      block(
        "T",
        tableOf([
          ["a", "b"],
          ["c", "d"],
        ]),
      ),
      block("P", para("x")),
    );

  /** 先頭セルにカーソルを置き、右クリック相当の open meta を適用した state */
  function openedState(): EditorState {
    const d = doc();
    const cell = cellPositions(d)[0];
    const base = EditorState.create({
      doc: d,
      plugins: [plugin],
      selection: TextSelection.create(d, contentPos(d, "P", "end")),
    });
    // 右クリックの tr は selection をセルへ移しつつ open する
    const tr = base.tr.setSelection(TextSelection.create(d, cell + 1));
    tr.setMeta(tableMenuKey, { type: "open", x: 100, y: 200 });
    return base.apply(tr);
  }

  function menuState(state: EditorState) {
    return tableMenuKey.getState(state)!;
  }

  test("open は selection を同時に動かしても active になる", () => {
    expect(menuState(openedState())).toEqual({ active: true, x: 100, y: 200, index: 0 });
  });

  test("nav で index が変わり、close で閉じる", () => {
    const state = openedState();
    const navved = state.apply(state.tr.setMeta(tableMenuKey, { type: "nav", index: 3 }));
    expect(menuState(navved)).toMatchObject({ active: true, index: 3 });
    const closed = navved.apply(navved.tr.setMeta(tableMenuKey, { type: "close" }));
    expect(menuState(closed)).toEqual({ active: false });
  });

  test("表示中のタイピングで閉じる", () => {
    const state = openedState();
    const next = state.apply(state.tr.insertText("z"));
    expect(menuState(next)).toEqual({ active: false });
  });

  test("selection が表の外へ移ると閉じる", () => {
    const state = openedState();
    const next = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, contentPos(state.doc, "P", "end"))),
    );
    expect(menuState(next)).toEqual({ active: false });
  });

  test("項目の command はカーソル位置の表に効く（Delete row で行が減る）", () => {
    const state = openedState();
    const deleteRow = TABLE_MENU_ITEMS.find((item) => item.label === "Delete row")!;
    let next = state;
    deleteRow.command(state, (tr) => {
      next = state.apply(tr);
    });
    expect(next.doc.child(0).child(0).child(0).childCount).toBe(1);
    expect(menuState(next)).toEqual({ active: false });
  });
});
