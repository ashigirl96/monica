/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { EditorState } from "@milkdown/kit/prose/state";
import { history, undoDepth } from "@milkdown/kit/prose/history";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { acceptedPastedImageSrc, createContainer, nodes, schema } from "./schema";
import {
  buildInsertImagesTr,
  imageUploadKey,
  imageUploadPlugin,
  isExternalImageSrc,
} from "./image-upload";

function para(text = ""): PMNode {
  return nodes.paragraph.create(null, text ? schema.text(text) : undefined);
}
function docOf(...blocks: PMNode[]): PMNode {
  return nodes.doc.create(null, nodes.blockGroup.create(null, blocks));
}
function imageBlock(uploadId: string | null, src: string | null = null): PMNode {
  return createContainer(nodes.image.create({ src, uploadId }));
}

function stateWith(doc: PMNode): EditorState {
  return EditorState.create({
    doc,
    plugins: [history(), imageUploadPlugin({ upload: async () => null })],
  });
}

function imageNodes(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type === nodes.image) out.push(node);
  });
  return out;
}

function hasBlobSrc(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    const src = node.attrs?.src;
    if (typeof src === "string" && src.startsWith("blob:")) found = true;
  });
  return found;
}

describe("buildInsertImagesTr", () => {
  test("空 paragraph は image block で置き換える（blob: を doc に入れない）", () => {
    const state = stateWith(docOf(createContainer(para())));
    const tr = buildInsertImagesTr(state, ["u1"]);
    expect(tr).not.toBeNull();
    const images = imageNodes(tr!.doc);
    expect(images).toHaveLength(1);
    expect(images[0].attrs.uploadId).toBe("u1");
    expect(images[0].attrs.src).toBeNull();
    expect(hasBlobSrc(tr!.doc)).toBe(false);
  });

  test("テキスト block の直後に挿入する", () => {
    const state = stateWith(docOf(createContainer(para("hello"))));
    const tr = buildInsertImagesTr(state, ["u1"]);
    const group = tr!.doc.child(0);
    expect(group.childCount).toBe(2);
    expect(group.child(0).child(0).textContent).toBe("hello");
    expect(group.child(1).child(0).type).toBe(nodes.image);
  });

  test("複数 uploadId を一括挿入する", () => {
    const state = stateWith(docOf(createContainer(para())));
    const tr = buildInsertImagesTr(state, ["u1", "u2", "u3"]);
    expect(imageNodes(tr!.doc)).toHaveLength(3);
  });
});

describe("upload state machine + appendTransaction swap", () => {
  const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });

  test("add → done で image node の src を確定 URL に差し替え、uploadId を消す", () => {
    const s0 = stateWith(docOf(imageBlock("u1")));
    const s1 = s0.apply(
      s0.tr.setMeta(imageUploadKey, {
        type: "add",
        entries: [{ uploadId: "u1", objectUrl: "blob:fake", file }],
      }),
    );
    expect(imageUploadKey.getState(s1)?.get("u1")?.status).toBe("uploading");

    const s2 = s1.apply(
      s1.tr.setMeta(imageUploadKey, { type: "done", uploadId: "u1", url: "/api/assets/a.png" }),
    );
    const images = imageNodes(s2.doc);
    expect(images).toHaveLength(1);
    expect(images[0].attrs.src).toBe("/api/assets/a.png");
    expect(images[0].attrs.uploadId).toBeNull();
    expect(hasBlobSrc(s2.doc)).toBe(false);
  });

  test("swap は履歴に乗らない（addToHistory: false）", () => {
    // fixture の image node は挿入経由でないので undoDepth の起点は 0。swap 後も 0 なら
    // swap が history に記録されていない = Cmd+Z が swap を単独で巻き戻せない。
    const s0 = stateWith(docOf(imageBlock("u1")));
    const s1 = s0.apply(
      s0.tr.setMeta(imageUploadKey, {
        type: "add",
        entries: [{ uploadId: "u1", objectUrl: "blob:fake", file }],
      }),
    );
    expect(undoDepth(s1)).toBe(0);
    const s2 = s1.apply(
      s1.tr.setMeta(imageUploadKey, { type: "done", uploadId: "u1", url: "/api/assets/a.png" }),
    );
    expect(undoDepth(s2)).toBe(0);
    expect(imageNodes(s2.doc)[0].attrs.src).toBe("/api/assets/a.png");
  });

  test("対象 node が doc に無くても entry は done で保持される（undo/redo レース対策）", () => {
    const s0 = stateWith(docOf(createContainer(para("no image"))));
    const s1 = s0.apply(
      s0.tr.setMeta(imageUploadKey, {
        type: "add",
        entries: [{ uploadId: "u1", objectUrl: "blob:fake", file }],
      }),
    );
    const s2 = s1.apply(
      s1.tr.setMeta(imageUploadKey, { type: "done", uploadId: "u1", url: "/api/assets/a.png" }),
    );
    const entry = imageUploadKey.getState(s2)?.get("u1");
    expect(entry && typeof entry.status === "object" ? entry.status.done : null).toBe(
      "/api/assets/a.png",
    );
    expect(imageNodes(s2.doc)).toHaveLength(0);
  });
});

describe("外部 img 検出", () => {
  test("外部 http(s) のみ import 対象、/api/assets/ は除外", () => {
    expect(isExternalImageSrc("https://example.com/a.png")).toBe(true);
    expect(isExternalImageSrc("http://example.com/a.png")).toBe(true);
    expect(isExternalImageSrc("/api/assets/a.png")).toBe(false);
    expect(isExternalImageSrc("blob:xyz")).toBe(false);
    expect(isExternalImageSrc(null)).toBe(false);
  });
});

describe("acceptedPastedImageSrc", () => {
  test("http(s) と自前 asset URL を許可、blob:/data:/javascript: を拒否", () => {
    expect(acceptedPastedImageSrc("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(acceptedPastedImageSrc("/api/assets/a.png")).toBe("/api/assets/a.png");
    expect(acceptedPastedImageSrc("blob:xyz")).toBeNull();
    expect(acceptedPastedImageSrc("data:image/png;base64,AAA")).toBeNull();
    expect(acceptedPastedImageSrc("javascript:alert(1)")).toBeNull();
    expect(acceptedPastedImageSrc(null)).toBeNull();
  });
});
