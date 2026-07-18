/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { EditorState } from "@milkdown/kit/prose/state";
import { Node as PMNode } from "@milkdown/kit/prose/model";
import { createContainer, nodes, reissueIds, schema } from "./schema";
import { serializeBlocksPayload } from "./clipboard";
import { buildSyncedContainer, previewPasteTransaction } from "./paste-menu";
import type { PasteMenuActiveState } from "./paste-menu";

function textContainer(text: string, id: string): PMNode {
  return createContainer(nodes.paragraph.create(null, schema.text(text)), [], id);
}

function firstContainer(state: EditorState): PMNode {
  return state.doc.firstChild!.firstChild!;
}

describe("buildSyncedContainer", () => {
  test("選択範囲全体を 1 つの synced ミラー（blockIds は選択順）にまとめる", () => {
    const originals = [textContainer("a", "src-1"), textContainer("b", "src-2")];
    const mirror = buildSyncedContainer(originals, "note-A");
    const content = mirror.child(0);
    expect(content.type).toBe(nodes.syncedBlock);
    expect(content.attrs.noteId).toBe("note-A");
    expect(content.attrs.blockIds).toEqual(["src-1", "src-2"]);
  });

  test("ラップする container には新しい id が振られる（元 id は syncedBlock 側に閉じる）", () => {
    const mirror = buildSyncedContainer([textContainer("a", "src-1")], "note-A");
    expect(mirror.attrs.id).not.toBe("src-1");
    expect(mirror.attrs.id).not.toBeNull();
  });

  test("sync-of-sync: 単一 synced block の複製は参照先を引き継ぐ（チェーン化しない）", () => {
    const existing = createContainer(
      nodes.syncedBlock.create({ noteId: "note-orig", blockIds: ["blk-a", "blk-b"] }),
      [],
      "wrapper-1",
    );
    const mirror = buildSyncedContainer([existing], "note-A");
    const content = mirror.child(0);
    expect(content.type).toBe(nodes.syncedBlock);
    expect(content.attrs.noteId).toBe("note-orig");
    expect(content.attrs.blockIds).toEqual(["blk-a", "blk-b"]);
  });
});

describe("previewPasteTransaction", () => {
  function pastedState(plain: PMNode[]): { state: EditorState; start: number } {
    const doc = nodes.doc.create(null, nodes.blockGroup.create(null, plain));
    // 先頭 blockContainer の before position（doc=0, blockGroup 内容=1）
    return { state: EditorState.create({ doc }), start: 1 };
  }

  test("paste ↔ sync のトグルが round-trip する（複数ブロックは 1 つの synced にまとまる）", () => {
    const originals = [textContainer("hello", "src-1"), textContainer("world", "src-2")];
    const plain = originals.map(reissueIds);
    const synced = [buildSyncedContainer(originals, "note-A")];
    const { state, start } = pastedState(plain);
    const base: PasteMenuActiveState = { active: true, start, index: 0, plain, synced };

    // → sync（2 ブロックが 1 つの synced block にまとまる）
    const toSync = previewPasteTransaction(state, base, 1);
    expect(toSync).not.toBeNull();
    const synced1 = state.apply(toSync!.tr);
    expect(synced1.doc.firstChild!.childCount).toBe(1);
    expect(firstContainer(synced1).child(0).type).toBe(nodes.syncedBlock);
    expect(firstContainer(synced1).child(0).attrs.blockIds).toEqual(["src-1", "src-2"]);
    expect(toSync!.next.index).toBe(1);

    // → paste（plain へ戻す: 2 ブロックに展開される）
    const back = previewPasteTransaction(synced1, toSync!.next, 0);
    expect(back).not.toBeNull();
    const plain2 = synced1.apply(back!.tr);
    expect(plain2.doc.firstChild!.childCount).toBe(2);
    expect(firstContainer(plain2).child(0).type).toBe(nodes.paragraph);
    expect(firstContainer(plain2).child(0).textContent).toBe("hello");
    expect(back!.next.index).toBe(0);
  });

  test("plain は元 blockId を再発行する（synced は元 id を保つ）", () => {
    const original = textContainer("x", "src-1");
    const plain = [reissueIds(original)];
    expect(plain[0].attrs.id).not.toBe("src-1");

    const synced = buildSyncedContainer([original], "note-A");
    expect(synced.child(0).attrs.blockIds).toEqual(["src-1"]);
  });
});

describe("syncedBlock schema", () => {
  test("PMNode.fromJSON で round-trip し attrs を保つ", () => {
    const container = createContainer(
      nodes.syncedBlock.create({ noteId: "note-A", blockIds: ["blk-1", "blk-2"] }),
      [],
      "wrapper-1",
    );
    const restored = PMNode.fromJSON(schema, container.toJSON());
    expect(restored.child(0).type).toBe(nodes.syncedBlock);
    expect(restored.child(0).attrs.noteId).toBe("note-A");
    expect(restored.child(0).attrs.blockIds).toEqual(["blk-1", "blk-2"]);
  });

  test("reissueIds は container の id だけ変え、syncedBlock の参照先 attrs は透過する", () => {
    const container = createContainer(
      nodes.syncedBlock.create({ noteId: "note-A", blockIds: ["blk-1", "blk-2"] }),
      [],
      "wrapper-1",
    );
    const reissued = reissueIds(container);
    expect(reissued.attrs.id).not.toBe("wrapper-1");
    expect(reissued.child(0).attrs.noteId).toBe("note-A");
    expect(reissued.child(0).attrs.blockIds).toEqual(["blk-1", "blk-2"]);
  });
});

describe("serializeBlocksPayload", () => {
  test("sourceNoteId を渡すと payload に載る", () => {
    const payload = JSON.parse(
      serializeBlocksPayload([textContainer("a", "src-1")], "copy", "note-A"),
    );
    expect(payload.sourceNoteId).toBe("note-A");
    expect(payload.schemaVersion).toBe(1);
  });

  test("sourceNoteId 省略時は payload に含めない（旧 payload 互換）", () => {
    const payload = JSON.parse(serializeBlocksPayload([textContainer("a", "src-1")], "copy"));
    expect(payload.sourceNoteId).toBeUndefined();
  });
});
