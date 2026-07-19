import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import { ASSET_URL_PREFIX, createContainer, nodes } from "./schema";
import { getBlockContext } from "./context";

/** File を asset にアップロードし、確定 URL を返す。失敗は null（縮退）。 */
export type UploadImage = (file: File) => Promise<{ url: string } | null>;
/** 外部画像 URL を backend 経由でローカル asset 化し、確定 URL を返す。失敗は null。 */
export type ImportExternalImage = (url: string) => Promise<{ url: string } | null>;

export type ImageUploadCallbacks = {
  upload: UploadImage;
  importExternal?: ImportExternalImage;
};

// アップロード中は blob: を doc に入れず、uploadId → ObjectURL の対応を plugin state に持つ。
// done になっても entry は destroy まで残す（undo で uploadId 付き node が戻ったら再 swap するため）。
type PendingSeed = { uploadId: string; objectUrl: string; file: File };
type PendingStatus = "uploading" | "failed" | { done: string };
export type PendingEntry = { objectUrl: string; file: File; status: PendingStatus };
export type ImageUploadState = Map<string, PendingEntry>;

type ImageUploadMeta =
  | { type: "add"; entries: PendingSeed[] }
  | { type: "uploading"; uploadId: string }
  | { type: "failed"; uploadId: string }
  | { type: "done"; uploadId: string; url: string };

export const imageUploadKey = new PluginKey<ImageUploadState>("imageUpload");

const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** DataTransfer から受け入れ可能な raster 画像 File だけを取り出す（SVG 等は除外）。 */
export function rasterImageFiles(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  return Array.from(dt.files).filter((f) => RASTER_TYPES.has(f.type));
}

function doneUrl(status: PendingStatus): string | null {
  return typeof status === "object" ? status.done : null;
}

/** uploadId 群の image block を挿入する Transaction を組む（純関数）。dropPos 指定時はその位置の
    block の直後、未指定（paste）時は空 paragraph 置換 / カーソル block 直後。doc に blob: は入れない。 */
export function buildInsertImagesTr(
  state: EditorState,
  uploadIds: readonly string[],
  dropPos?: number,
): Transaction | null {
  if (uploadIds.length === 0) return null;
  const containers = uploadIds.map((uploadId) =>
    createContainer(nodes.image.create({ src: null, uploadId })),
  );
  const tr = state.tr;
  const $pos =
    dropPos !== undefined ? state.doc.resolve(clampToDoc(state, dropPos)) : state.selection.$from;
  const ctx = getBlockContext($pos);
  if (!ctx) {
    // block 境界が取れない（drop がドキュメント端）ときは最上位 group の末尾へ。
    const group = state.doc.child(0);
    tr.insert(1 + group.content.size, containers);
    return tr.scrollIntoView();
  }
  if (
    dropPos === undefined &&
    ctx.contentNode.type === nodes.paragraph &&
    ctx.contentNode.content.size === 0 &&
    ctx.containerNode.childCount === 1
  ) {
    tr.replaceWith(ctx.containerPos, ctx.containerPos + ctx.containerNode.nodeSize, containers);
  } else {
    tr.insert(ctx.containerPos + ctx.containerNode.nodeSize, containers);
  }
  return tr.scrollIntoView();
}

function clampToDoc(state: EditorState, pos: number): number {
  return Math.max(0, Math.min(pos, state.doc.content.size));
}

function applyMeta(state: ImageUploadState, meta: ImageUploadMeta): ImageUploadState {
  const next = new Map(state);
  switch (meta.type) {
    case "add":
      for (const seed of meta.entries) {
        next.set(seed.uploadId, {
          objectUrl: seed.objectUrl,
          file: seed.file,
          status: "uploading",
        });
      }
      break;
    case "uploading": {
      const e = next.get(meta.uploadId);
      if (e) next.set(meta.uploadId, { ...e, status: "uploading" });
      break;
    }
    case "failed": {
      const e = next.get(meta.uploadId);
      if (e) next.set(meta.uploadId, { ...e, status: "failed" });
      break;
    }
    case "done": {
      const e = next.get(meta.uploadId);
      if (e) next.set(meta.uploadId, { ...e, status: { done: meta.url } });
      break;
    }
  }
  return next;
}

// done entry を持つ uploadId の image node を確定 URL に差し替える tr（履歴外）。node が無ければ null。
function buildSwapTr(state: EditorState): Transaction | null {
  const upload = imageUploadKey.getState(state);
  if (!upload || upload.size === 0) return null;
  let tr: Transaction | null = null;
  state.doc.descendants((node, pos) => {
    if (node.type !== nodes.image) return;
    const uploadId = node.attrs.uploadId as string | null;
    if (!uploadId) return;
    const entry = upload.get(uploadId);
    if (!entry) return;
    const url = doneUrl(entry.status);
    if (url === null) return;
    tr = (tr ?? state.tr).setNodeMarkup(pos, undefined, {
      ...node.attrs,
      src: url,
      uploadId: null,
    });
  });
  if (tr) (tr as Transaction).setMeta("addToHistory", false);
  return tr;
}

export function isExternalImageSrc(src: string | null): src is string {
  return !!src && !src.startsWith(ASSET_URL_PREFIX) && /^https?:\/\//.test(src);
}

export function imageUploadPlugin(callbacks: ImageUploadCallbacks): Plugin<ImageUploadState> {
  const { upload, importExternal } = callbacks;

  async function runUpload(view: EditorView, uploadId: string, file: File): Promise<void> {
    const result = await upload(file);
    const meta: ImageUploadMeta = result
      ? { type: "done", uploadId, url: result.url }
      : { type: "failed", uploadId };
    view.dispatch(view.state.tr.setMeta(imageUploadKey, meta));
  }

  function startInsert(view: EditorView, files: File[], dropPos?: number): boolean {
    if (files.length === 0) return false;
    const seeds: PendingSeed[] = files.map((file) => ({
      uploadId: crypto.randomUUID(),
      objectUrl: URL.createObjectURL(file),
      file,
    }));
    const tr = buildInsertImagesTr(
      view.state,
      seeds.map((s) => s.uploadId),
      dropPos,
    );
    if (!tr) {
      for (const s of seeds) URL.revokeObjectURL(s.objectUrl);
      return false;
    }
    tr.setMeta(imageUploadKey, { type: "add", entries: seeds });
    view.dispatch(tr);
    for (const s of seeds) void runUpload(view, s.uploadId, s.file);
    return true;
  }

  return new Plugin<ImageUploadState>({
    key: imageUploadKey,
    state: {
      init: () => new Map(),
      apply(tr, value) {
        const meta = tr.getMeta(imageUploadKey) as ImageUploadMeta | undefined;
        return meta ? applyMeta(value, meta) : value;
      },
    },
    appendTransaction: (_trs, _old, newState) => buildSwapTr(newState),
    props: {
      handlePaste(view, event) {
        const files = rasterImageFiles(event.clipboardData);
        return startInsert(view, files);
      },
      handleDrop(view, event) {
        const files = rasterImageFiles(event.dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        return startInsert(view, files, at?.pos);
      },
      decorations(state) {
        const upload = imageUploadKey.getState(state);
        if (!upload || upload.size === 0) return null;
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type !== nodes.image) return;
          const uploadId = node.attrs.uploadId as string | null;
          if (!uploadId) return;
          const entry = upload.get(uploadId);
          if (!entry) return;
          const cls =
            entry.status === "failed"
              ? "jb-image-failed"
              : entry.status === "uploading"
                ? "jb-image-uploading"
                : null;
          if (cls) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: cls }));
        });
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
    },
    view(editorView) {
      const attempted = new Set<string>();

      const runImport = async (src: string): Promise<void> => {
        if (!importExternal) return;
        const result = await importExternal(src);
        if (!result) return; // 失敗時は外部 URL のまま残す
        const tr = editorView.state.tr;
        let changed = false;
        editorView.state.doc.descendants((node, pos) => {
          if (node.type === nodes.image && node.attrs.src === src) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: result.url });
            changed = true;
          }
        });
        if (changed) editorView.dispatch(tr.setMeta("addToHistory", false));
      };

      const scan = (state: EditorState): void => {
        if (!importExternal) return;
        state.doc.descendants((node) => {
          if (node.type !== nodes.image) return;
          const src = node.attrs.src as string | null;
          if (!isExternalImageSrc(src) || attempted.has(src)) return;
          attempted.add(src);
          void runImport(src);
        });
      };

      retryByView.set(editorView, (uploadId: string) => {
        const entry = imageUploadKey.getState(editorView.state)?.get(uploadId);
        if (!entry) return;
        editorView.dispatch(
          editorView.state.tr.setMeta(imageUploadKey, { type: "uploading", uploadId }),
        );
        void runUpload(editorView, uploadId, entry.file);
      });

      scan(editorView.state);
      return {
        update(view, prev) {
          if (view.state.doc !== prev.doc) scan(view.state);
        },
        destroy() {
          retryByView.delete(editorView);
          imageUploadKey
            .getState(editorView.state)
            ?.forEach((e) => URL.revokeObjectURL(e.objectUrl));
        },
      };
    },
  });
}

// ImageView（node-views.ts）の retry ボタンから、plugin closure の runUpload を呼ぶための橋渡し。
const retryByView = new WeakMap<EditorView, (uploadId: string) => void>();

export function retryImageUpload(view: EditorView, uploadId: string): void {
  retryByView.get(view)?.(uploadId);
}
