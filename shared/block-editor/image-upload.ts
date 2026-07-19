import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import { ASSET_URL_PREFIX, createContainer, isHttpUrl, nodes } from "./schema";
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
type PendingStatus = "uploading" | "failed" | "done";
export type PendingEntry = {
  objectUrl: string;
  file: File;
  status: PendingStatus;
  /** status === "done" のときの確定 URL。それ以外は null。 */
  doneUrl: string | null;
};
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

// blockContainer が「アップロード未完了の image ただ 1 つ」だけを内容に持つか。
// （子ブロックを持つ稀なケースは length !== 1 で保守的に残す＝ユーザー内容を落とさない）
function isPendingImageContainer(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as { type?: string; content?: unknown };
  if (n.type !== "blockContainer" || !Array.isArray(n.content) || n.content.length !== 1) {
    return false;
  }
  const inner = n.content[0] as { type?: string; attrs?: { src?: unknown } };
  return inner?.type === "image" && (inner.attrs?.src ?? null) === null;
}

/** 永続化用に doc JSON からアップロード未完了（src === null）の image block を取り除く（純関数）。
    uploadId → blob の対応はタブ内の plugin state にしか無く destroy で消えるため、src:null を
    保存すると再読込で復元不能な placeholder になり、bytes も孤児化する。確定 src を持つ image
    だけを残せば、アップロード完了時の swap 後に改めて保存される（結果整合）。 */
export function stripPendingImages(docJson: unknown): unknown {
  if (!docJson || typeof docJson !== "object") return docJson;
  const node = docJson as { content?: unknown };
  if (!Array.isArray(node.content)) return docJson;
  return {
    ...node,
    content: node.content.filter((c) => !isPendingImageContainer(c)).map(stripPendingImages),
  };
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
  if (meta.type === "add") {
    for (const seed of meta.entries) {
      next.set(seed.uploadId, { ...seed, status: "uploading", doneUrl: null });
    }
    return next;
  }
  const e = next.get(meta.uploadId);
  if (e) {
    next.set(meta.uploadId, {
      ...e,
      status: meta.type,
      doneUrl: meta.type === "done" ? meta.url : null,
    });
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
    const url = upload.get(uploadId)?.doneUrl;
    if (!url) return;
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
  return !!src && !src.startsWith(ASSET_URL_PREFIX) && isHttpUrl(src);
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
        // decoration は uploading/failed の間だけ要る。done ばかりの定常状態では map を
        // O(images) で覗いて早期 return し、全 done 後に doc 全走査が続くのを防ぐ。
        if (!upload || !hasPendingVisual(upload)) return null;
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type !== nodes.image) return;
          const uploadId = node.attrs.uploadId as string | null;
          const status = uploadId ? upload.get(uploadId)?.status : undefined;
          const cls =
            status === "failed"
              ? "jb-image-failed"
              : status === "uploading"
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

      // retry は NodeView が uploading meta を dispatch するだけ（他の NodeView→plugin 操作と同じ形）。
      // その failed→uploading 遷移をここで検知して upload を再起動する。add 直後（prev 無し）は
      // startInsert が既に起動済みなので二重起動しない。
      const kickRetries = (state: EditorState, prev: EditorState): void => {
        const cur = imageUploadKey.getState(state);
        const before = imageUploadKey.getState(prev);
        if (!cur) return;
        for (const [uploadId, entry] of cur) {
          if (entry.status === "uploading" && before?.get(uploadId)?.status === "failed") {
            void runUpload(editorView, uploadId, entry.file);
          }
        }
      };

      scan(editorView.state);
      return {
        update(view, prev) {
          if (view.state.doc !== prev.doc) scan(view.state);
          kickRetries(view.state, prev);
        },
        destroy() {
          imageUploadKey
            .getState(editorView.state)
            ?.forEach((e) => URL.revokeObjectURL(e.objectUrl));
        },
      };
    },
  });
}

function hasPendingVisual(upload: ImageUploadState): boolean {
  for (const entry of upload.values()) {
    if (entry.status === "uploading" || entry.status === "failed") return true;
  }
  return false;
}

/** ImageView の retry ボタンから呼ぶ。uploading meta を dispatch するだけで、plugin の
    view.update が upload を再起動する（WeakMap 経由の side-channel を使わない）。 */
export function requestImageRetry(view: EditorView, uploadId: string): void {
  if (imageUploadKey.getState(view.state)?.get(uploadId)?.status !== "failed") return;
  view.dispatch(view.state.tr.setMeta(imageUploadKey, { type: "uploading", uploadId }));
}
