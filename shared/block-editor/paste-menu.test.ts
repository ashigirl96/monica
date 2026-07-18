/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { EditorState } from "@milkdown/kit/prose/state";
import { Node as PMNode } from "@milkdown/kit/prose/model";
import { createContainer, nodes, reissueIds, schema } from "./schema";
import { serializeBlocksPayload } from "./clipboard";
import { buildSyncedContainers, previewPasteTransaction } from "./paste-menu";
import type { PasteMenuActiveState } from "./paste-menu";

function textContainer(text: string, id: string): PMNode {
  return createContainer(nodes.paragraph.create(null, schema.text(text)), [], id);
}

function firstContainer(state: EditorState): PMNode {
  return state.doc.firstChild!.firstChild!;
}

describe("buildSyncedContainers", () => {
  test("各 container を (sourceNoteId, 元 blockId) を指す synced ミラーにする", () => {
    const originals = [textContainer("a", "src-1"), textContainer("b", "src-2")];
    const synced = buildSyncedContainers(originals, "note-A");

    expect(synced).toHaveLength(2);
    for (const [i, container] of synced.entries()) {
      const content = container.child(0);
      expect(content.type).toBe(nodes.syncedBlock);
      expect(content.attrs.noteId).toBe("note-A");
      expect(content.attrs.blockId).toBe(`src-${i + 1}`);
    }
  });

  test("ラップする container には新しい id が振られる（元 id は syncedBlock 側に閉じる）", () => {
    const [mirror] = buildSyncedContainers([textContainer("a", "src-1")], "note-A");
    expect(mirror.attrs.id).not.toBe("src-1");
    expect(mirror.attrs.id).not.toBeNull();
  });

  test("sync-of-sync: 既に syncedBlock を包む container は参照先を引き継ぐ（チェーン化しない）", () => {
    const existing = createContainer(
      nodes.syncedBlock.create({ noteId: "note-orig", blockId: "blk-orig" }),
      [],
      "wrapper-1",
    );
    const [mirror] = buildSyncedContainers([existing], "note-A");
    const content = mirror.child(0);
    expect(content.type).toBe(nodes.syncedBlock);
    expect(content.attrs.noteId).toBe("note-orig");
    expect(content.attrs.blockId).toBe("blk-orig");
  });
});

describe("previewPasteTransaction", () => {
  function pastedState(plain: PMNode[]): { state: EditorState; start: number } {
    const doc = nodes.doc.create(null, nodes.blockGroup.create(null, plain));
    // 先頭 blockContainer の before position（doc=0, blockGroup 内容=1）
    return { state: EditorState.create({ doc }), start: 1 };
  }

  test("paste ↔ sync のトグルが round-trip する", () => {
    const original = textContainer("hello", "src-1");
    const plain = [reissueIds(original)];
    const synced = buildSyncedContainers([original], "note-A");
    const { state, start } = pastedState(plain);
    const size = plain[0].nodeSize;
    const base: PasteMenuActiveState = { active: true, start, size, index: 0, plain, synced };

    // → sync
    const toSync = previewPasteTransaction(state, base, 1);
    expect(toSync).not.toBeNull();
    const synced1 = state.apply(toSync!.tr);
    expect(firstContainer(synced1).child(0).type).toBe(nodes.syncedBlock);
    expect(firstContainer(synced1).child(0).attrs.blockId).toBe("src-1");
    expect(toSync!.next.index).toBe(1);
    expect(toSync!.next.size).toBe(synced[0].nodeSize);

    // → paste（plain へ戻す）
    const back = previewPasteTransaction(synced1, toSync!.next, 0);
    expect(back).not.toBeNull();
    const plain2 = synced1.apply(back!.tr);
    expect(firstContainer(plain2).child(0).type).toBe(nodes.paragraph);
    expect(firstContainer(plain2).child(0).textContent).toBe("hello");
    expect(back!.next.index).toBe(0);
  });

  test("plain は元 blockId を再発行する（synced は元 id を保つ）", () => {
    const original = textContainer("x", "src-1");
    const plain = [reissueIds(original)];
    expect(plain[0].attrs.id).not.toBe("src-1");

    const synced = buildSyncedContainers([original], "note-A");
    expect(synced[0].child(0).attrs.blockId).toBe("src-1");
  });
});

describe("syncedBlock schema", () => {
  test("PMNode.fromJSON で round-trip し attrs を保つ", () => {
    const container = createContainer(
      nodes.syncedBlock.create({ noteId: "note-A", blockId: "blk-1" }),
      [],
      "wrapper-1",
    );
    const restored = PMNode.fromJSON(schema, container.toJSON());
    expect(restored.child(0).type).toBe(nodes.syncedBlock);
    expect(restored.child(0).attrs.noteId).toBe("note-A");
    expect(restored.child(0).attrs.blockId).toBe("blk-1");
  });

  test("reissueIds は container の id だけ変え、syncedBlock の参照先 attrs は透過する", () => {
    const container = createContainer(
      nodes.syncedBlock.create({ noteId: "note-A", blockId: "blk-1" }),
      [],
      "wrapper-1",
    );
    const reissued = reissueIds(container);
    expect(reissued.attrs.id).not.toBe("wrapper-1");
    expect(reissued.child(0).attrs.noteId).toBe("note-A");
    expect(reissued.child(0).attrs.blockId).toBe("blk-1");
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
