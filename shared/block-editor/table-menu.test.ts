/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { block, cellPositions, contentPos, docOf, para, tableOf } from "./test-fixtures";
import { TABLE_MENU_ITEMS, tableMenuPlugin } from "./table-menu";
import { linkMenuPlugin, openLinkMenu } from "./link-menu";
import { linkMenuKey, tableMenuKey } from "./menu-keys";

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

describe("他メニューが開いている間は contextmenu を譲る", () => {
  /** contextmenu handler が必要とする最小限の EditorView 相当 */
  function fakeView(state: EditorState, cellPos: number) {
    const dispatched: unknown[] = [];
    return {
      view: {
        state,
        posAtCoords: () => ({ pos: cellPos, inside: cellPos }),
        dispatch: (tr: unknown) => dispatched.push(tr),
      },
      dispatched,
    };
  }

  function contextmenuOn(state: EditorState, cellPos: number) {
    const { view, dispatched } = fakeView(state, cellPos);
    let defaultPrevented = false;
    const event = {
      clientX: 10,
      clientY: 20,
      preventDefault: () => {
        defaultPrevented = true;
      },
    };
    const plugin = tableMenuPlugin();
    const handler = plugin.props.handleDOMEvents!.contextmenu!;
    // biome-ignore lint/suspicious/noExplicitAny: 最小限の view / event スタブ
    const handled = handler.call(plugin, view as any, event as any);
    return { handled, dispatched, defaultPrevented };
  }

  const tableDoc = () =>
    docOf(
      block(
        "T",
        tableOf([
          ["a", "b"],
          ["c", "d"],
        ]),
      ),
    );

  test("link-menu が開いていればセル上でも開かず、native メニューに任せる", () => {
    const d = tableDoc();
    const cell = cellPositions(d)[0] + 1;
    const base = EditorState.create({
      doc: d,
      plugins: [tableMenuPlugin(), linkMenuPlugin(async () => null)],
      selection: TextSelection.create(d, cell),
    });
    const state = base.apply(openLinkMenu(base.tr, cell, "https://example.com"));
    expect(linkMenuKey.getState(state)).toMatchObject({ active: true });

    const { handled, dispatched, defaultPrevented } = contextmenuOn(state, cell);
    expect(handled).toBe(false);
    expect(dispatched).toHaveLength(0);
    expect(defaultPrevented).toBe(false);
  });

  test("他メニューが閉じていればセル上で開く", () => {
    const d = tableDoc();
    const cell = cellPositions(d)[0] + 1;
    const state = EditorState.create({
      doc: d,
      plugins: [tableMenuPlugin(), linkMenuPlugin(async () => null)],
      selection: TextSelection.create(d, cell),
    });
    const { handled, dispatched, defaultPrevented } = contextmenuOn(state, cell);
    expect(handled).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(defaultPrevented).toBe(true);
  });
});
