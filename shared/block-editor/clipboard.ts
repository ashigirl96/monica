import { type EditorState, Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { DOMSerializer, Fragment, Node as PMNode, Slice } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { nodes, reissueIds, schema } from "./schema";
import { containerById, getBlockContext, rangeFromIds, rangePositions } from "./context";
import { deleteRange } from "./commands";
import { blockSelectionKey } from "./selection-state";
import { openLinkMenu } from "./link-menu";
import { buildSyncedContainer, openPasteMenu } from "./paste-menu";

// TODO.md §8.4 / §10.1
export const BLOCKS_MIME = "application/x-monica-blocks+json";

type BlocksPayload = {
  schemaVersion: 1;
  operation: "copy" | "move";
  blocks: unknown[];
  /** copy 元ノートの id。paste-and-sync のミラー参照先。旧 payload / desktop copy では欠落。 */
  sourceNoteId?: string;
};

export function serializeBlocksPayload(
  containers: readonly PMNode[],
  operation: "copy" | "move",
  sourceNoteId?: string,
): string {
  const payload: BlocksPayload = {
    schemaVersion: 1,
    operation,
    blocks: containers.map((node) => node.toJSON() as unknown),
    ...(sourceNoteId ? { sourceNoteId } : {}),
  };
  return JSON.stringify(payload);
}

export function blocksToPlainText(containers: readonly PMNode[]): string {
  const lines: string[] = [];
  const walk = (container: PMNode, depth: number) => {
    const content = container.child(0);
    let text: string;
    if (content.type === nodes.divider) text = "---";
    else if (content.type === nodes.syncedBlock) text = "[synced block]";
    else text = content.content.textBetween(0, content.content.size, undefined, "\n");
    lines.push("  ".repeat(depth) + text);
    if (container.childCount > 1) {
      container.child(1).forEach((child) => walk(child, depth + 1));
    }
  };
  for (const container of containers) walk(container, 0);
  return lines.join("\n");
}

// 外部 HTML/plain text に block ID を出さない（TODO.md §10.1）
function stripIds(node: PMNode): PMNode {
  if (node.type === nodes.blockContainer) {
    return node.type.create(
      { ...node.attrs, id: null },
      node.content.content.map(stripIds),
      node.marks,
    );
  }
  if (node.type === nodes.blockGroup) {
    return node.type.create(node.attrs, node.content.content.map(stripIds), node.marks);
  }
  return node;
}

function mapSliceNodes(slice: Slice, mapNode: (node: PMNode) => PMNode): Slice {
  const mapFragment = (fragment: Fragment): Fragment =>
    Fragment.from(
      fragment.content.map((node) => {
        const mapped = mapNode(node);
        // container/group は mapNode 内で再帰済み。それ以外は子だけ辿る
        if (mapped === node && node.childCount > 0 && !node.isText) {
          return node.copy(mapFragment(node.content));
        }
        return mapped;
      }),
    );
  return new Slice(mapFragment(slice.content), slice.openStart, slice.openEnd);
}

function blocksToHtml(containers: readonly PMNode[]): string {
  const serializer = DOMSerializer.fromSchema(schema);
  const holder = document.createElement("div");
  holder.append(
    serializer.serializeFragment(Fragment.from(containers.map(stripIds)), { document }),
  );
  return holder.innerHTML;
}

// 元 ID のままの container 群と sourceNoteId を返す。ID 再発行（plain paste）は呼び手の
// 責務 — paste-and-sync は元 blockId を参照先に使うため、ここでは reissue しない。
type ParsedBlocks = { blocks: PMNode[]; sourceNoteId: string | null };

function parseBlocksPayload(raw: string): ParsedBlocks | null {
  let payload: BlocksPayload;
  try {
    payload = JSON.parse(raw) as BlocksPayload;
  } catch {
    return null;
  }
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.blocks)) return null;
  try {
    const blocks = payload.blocks.map((json) => PMNode.fromJSON(schema, json));
    return { blocks, sourceNoteId: payload.sourceNoteId ?? null };
  } catch {
    return null;
  }
}

function selectedContainers(state: EditorState): PMNode[] {
  const selection = blockSelectionKey.getState(state);
  if (!selection || selection.selectedIds.length === 0) return [];
  return selection.selectedIds
    .map((id) => containerById(state.doc, id)?.node)
    .filter((node): node is PMNode => !!node);
}

/** 選択範囲 → to_markdown が食える doc JSON。block 選択は container 群を単一 blockGroup に包む。 */
function docJsonFromContainers(containers: readonly PMNode[]): unknown {
  return {
    type: "doc",
    content: [{ type: "blockGroup", content: containers.map((node) => node.toJSON()) }],
  };
}

/**
 * 現在の選択範囲を to_markdown が食える doc JSON にする。block 選択は container 群を、
 * text 選択は slice の fragment をそのまま doc に載せる（to_markdown はどちらの形にも寛容）。
 */
function selectionJson(state: EditorState): unknown | null {
  const containers = selectedContainers(state);
  if (containers.length > 0) return docJsonFromContainers(containers);
  const sel = state.selection;
  if (!sel.empty) return { type: "doc", content: sel.content().content.toJSON() ?? [] };
  return null;
}

/**
 * 選択範囲を doc JSON + signature に変換する（prefetch と copy で共有する単一経路）。
 * signature が一致することがキャッシュヒットの前提。copy 側は必ず view.state から再計算する
 * （transformCopied で id を潰した slice を使わない）ので prefetch と同一署名になる。
 */
function selectionDocJson(state: EditorState): { json: unknown; signature: string } | null {
  const json = selectionJson(state);
  return json ? { json, signature: JSON.stringify(json) } : null;
}

/** 単一トークンの http(s) URL の paste なら URL を返す（note-mention-menu と共有） */
export function pastedUrl(event: ClipboardEvent): string | null {
  const text = event.clipboardData?.getData("text/plain")?.trim();
  if (!text || /\s/.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return text;
}

// 単一 URL のペースト: プレーンリンクを即挿入し、表現の 3 択（URL/Mention/Bookmark）を
// link-menu に委ねる。選択テキストがあれば Notion 同様 link mark を付けるだけ。
function handleUrlPaste(view: EditorView, event: ClipboardEvent): boolean {
  const url = pastedUrl(event);
  if (!url) return false;
  const { state } = view;
  const sel = state.selection;
  const ctx = getBlockContext(sel.$from);
  if (!ctx || ctx.contentNode.type === nodes.codeBlock) return false;
  const linkMark = schema.marks.link.create({ href: url });
  if (!sel.empty) {
    if (!(sel instanceof TextSelection) || sel.$from.parent !== sel.$to.parent) return false;
    view.dispatch(state.tr.addMark(sel.from, sel.to, linkMark));
    return true;
  }
  const from = sel.from;
  const tr = state.tr.replaceWith(from, from, schema.text(url, [linkMark]));
  tr.setSelection(TextSelection.create(tr.doc, from + url.length));
  openLinkMenu(tr, from, url);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function writeBlocksToClipboard(
  event: ClipboardEvent,
  containers: readonly PMNode[],
  sourceNoteId?: string,
  // 先読み markdown がヒットしていれば text/plain に載せる（ミス時はインデント plain text に縮退）。
  // BLOCKS_MIME / html は常に同期で共存させ、paste-and-sync 経路を壊さない。
  markdownPlain?: string,
): void {
  if (!event.clipboardData) return;
  event.preventDefault();
  event.clipboardData.setData(
    BLOCKS_MIME,
    serializeBlocksPayload(containers, "copy", sourceNoteId),
  );
  event.clipboardData.setData("text/html", blocksToHtml(containers));
  event.clipboardData.setData("text/plain", markdownPlain ?? blocksToPlainText(containers));
}

/** 選択範囲の doc JSON を markdown へ投影する（Rust `to_markdown` への口）。失敗しない前提。 */
export type RenderMarkdown = (docJson: unknown) => Promise<string>;

export type ClipboardOptions = {
  /** copy 時に payload へ載せる現在ノートの id（paste-and-sync のミラー参照元）。 */
  sourceNoteId?: string;
  /** paste 時に「Paste and sync」を提示するか（= resolveBlock が提供されているか）。 */
  syncPasteEnabled?: boolean;
  /** 選択範囲を markdown へ投影する。未指定なら markdown コピーは無効（plain text 縮退）。 */
  renderMarkdown?: RenderMarkdown;
};

/** 選択が落ち着いてから先読み POST するまでの猶予。 */
const CLIPBOARD_PREFETCH_DEBOUNCE_MS = 150;
/** 先読み markdown キャッシュの上限（現在選択分だけ効けば十分なので小さくてよい）。 */
const MARKDOWN_CACHE_MAX = 16;

export function clipboardPlugin(options: ClipboardOptions = {}): Plugin {
  const { renderMarkdown } = options;

  // 非同期 clipboard の制約回避: 選択が変わるたびに markdown を先読みしておき、copy/cut の同期
  // ハンドラでは同期にキャッシュ参照するだけにする。ヒットしなければ従来の plain text に縮退。
  const cache = new Map<string, string>();
  const inflight = new Set<string>();

  const remember = (signature: string, markdown: string) => {
    cache.set(signature, markdown);
    // 1 回で 1 件しか増えないので上限超過は高々 1 件。最古（挿入順先頭）を落とす。
    if (cache.size > MARKDOWN_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  const prefetch = (signature: string, json: unknown) => {
    if (!renderMarkdown || cache.has(signature) || inflight.has(signature)) return;
    inflight.add(signature);
    renderMarkdown(json)
      .then((markdown) => remember(signature, markdown))
      .catch(() => {})
      .finally(() => inflight.delete(signature));
  };

  // copy 側は必ず view.state から署名を引き直す（transformCopied で id を潰した slice ではなく）。
  const lookupMarkdown = (state: EditorState): string | undefined => {
    const selected = selectionDocJson(state);
    return selected ? cache.get(selected.signature) : undefined;
  };

  return new Plugin({
    key: new PluginKey("journalClipboard"),
    view: renderMarkdown
      ? (editorView) => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          // 選択が落ち着いてから 1 回だけ選択を直列化して先読みする（毎トランザクションで
          // O(選択サイズ) の JSON.stringify を走らせない）。prefetch が cache/inflight で二重 POST を防ぐ。
          const settle = () => {
            timer = null;
            const selected = selectionDocJson(editorView.state);
            if (selected) prefetch(selected.signature, selected.json);
          };
          return {
            update(view, prevState) {
              // doc・text 選択・block 選択（blockSelectionKey は変更時のみ新参照）のいずれかが
              // 変わったときだけタイマーを張り直す。すべて O(1) の参照/位置比較。
              const changed =
                view.state.doc !== prevState.doc ||
                !view.state.selection.eq(prevState.selection) ||
                blockSelectionKey.getState(view.state) !== blockSelectionKey.getState(prevState);
              if (!changed) return;
              if (timer) clearTimeout(timer);
              timer = setTimeout(settle, CLIPBOARD_PREFETCH_DEBOUNCE_MS);
            },
            destroy() {
              if (timer) clearTimeout(timer);
            },
          };
        }
      : undefined,
    props: {
      // text mode copy は ProseMirror 標準に任せつつ、外部へ出る HTML から ID を剥がす
      transformCopied: (slice) => mapSliceNodes(slice, stripIds),
      // 外部・copy 由来 paste は ID 再発行（重複 ID は normalizer の防衛もある）
      transformPasted: (slice) => mapSliceNodes(slice, reissueIds),
      // text 選択の text/plain を markdown に差し替える（ヒット時のみ。ミス時は ProseMirror 標準と
      // 同じ textBetween に縮退）。block 選択は copy ハンドラが preventDefault するのでここは通らない。
      ...(renderMarkdown
        ? {
            clipboardTextSerializer: (slice: Slice, view: EditorView) =>
              lookupMarkdown(view.state) ??
              slice.content.textBetween(0, slice.content.size, "\n\n"),
          }
        : {}),

      handleDOMEvents: {
        copy(view, event) {
          const containers = selectedContainers(view.state);
          if (containers.length === 0) return false;
          writeBlocksToClipboard(
            event,
            containers,
            options.sourceNoteId,
            lookupMarkdown(view.state),
          );
          return true;
        },
        cut(view, event) {
          const containers = selectedContainers(view.state);
          if (containers.length === 0) return false;
          // cut は元ブロックを削除するので sourceNoteId を載せない。載せると paste-and-sync
          // が「消えたブロック」を指す dangling ミラーになる（cut は move であって参照元にならない）。
          writeBlocksToClipboard(event, containers, undefined, lookupMarkdown(view.state));
          const selection = blockSelectionKey.getState(view.state);
          const range = selection ? rangeFromIds(view.state, selection.selectedIds) : null;
          if (range) view.dispatch(deleteRange(view.state, range));
          return true;
        },
      },

      handlePaste(view, event) {
        const raw = event.clipboardData?.getData(BLOCKS_MIME);
        if (!raw) return handleUrlPaste(view, event);
        const parsed = parseBlocksPayload(raw);
        if (!parsed || parsed.blocks.length === 0) return false;
        const { blocks: originals, sourceNoteId } = parsed;
        // plain paste は常に ID 再発行（重複 ID は normalizer の防衛もある）
        const plain = originals.map(reissueIds);

        // 挿入位置 start を決めて plain を入れる。start より前は触らないので、
        // paste-menu のライブプレビュー（replaceWith）の安定アンカーになる。
        const tr = view.state.tr;
        let start: number;
        const selection = blockSelectionKey.getState(view.state);
        if (selection && selection.selectedIds.length > 0) {
          const range = rangeFromIds(view.state, selection.selectedIds);
          if (!range) return false;
          start = rangePositions(range).end;
          tr.insert(start, plain);
        } else {
          const ctx = getBlockContext(view.state.selection.$from);
          if (!ctx) return false;
          // 空 paragraph（子なし）の上なら置き換え、それ以外は直後に挿入
          if (
            ctx.contentNode.type === nodes.paragraph &&
            ctx.contentNode.content.size === 0 &&
            ctx.containerNode.childCount === 1
          ) {
            start = ctx.containerPos;
            tr.replaceWith(start, start + ctx.containerNode.nodeSize, plain);
          } else {
            start = ctx.containerPos + ctx.containerNode.nodeSize;
            tr.insert(start, plain);
          }
        }

        // paste-and-sync が可能なら「Paste as」メニューを相乗りさせる。plugin 未登録
        // （resolveBlock 不在）や旧 payload（sourceNoteId 欠落）なら plain のまま。
        if (
          options.syncPasteEnabled &&
          sourceNoteId &&
          originals.every((container) => container.attrs.id !== null)
        ) {
          openPasteMenu(tr, {
            start,
            plain,
            synced: [buildSyncedContainer(originals, sourceNoteId)],
          });
        }
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}
