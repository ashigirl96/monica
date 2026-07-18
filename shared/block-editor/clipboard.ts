import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { DOMSerializer, Fragment, Node as PMNode, Slice } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { nodes, reissueIds, schema } from "./schema";
import { containerById, getBlockContext, rangeFromIds, rangePositions } from "./context";
import { deleteRange } from "./commands";
import { blockSelectionKey } from "./selection-state";
import { openLinkMenu } from "./link-menu";
import { buildSyncedContainers, openPasteMenu } from "./paste-menu";

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

function selectedContainers(view: EditorView): PMNode[] {
  const selection = blockSelectionKey.getState(view.state);
  if (!selection || selection.selectedIds.length === 0) return [];
  return selection.selectedIds
    .map((id) => containerById(view.state.doc, id)?.node)
    .filter((node): node is PMNode => !!node);
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
): void {
  if (!event.clipboardData) return;
  event.preventDefault();
  event.clipboardData.setData(
    BLOCKS_MIME,
    serializeBlocksPayload(containers, "copy", sourceNoteId),
  );
  event.clipboardData.setData("text/html", blocksToHtml(containers));
  event.clipboardData.setData("text/plain", blocksToPlainText(containers));
}

export type ClipboardOptions = {
  /** copy 時に payload へ載せる現在ノートの id（paste-and-sync のミラー参照元）。 */
  sourceNoteId?: string;
  /** paste 時に「Paste and sync」を提示するか（= resolveBlock が提供されているか）。 */
  syncPasteEnabled?: boolean;
};

export function clipboardPlugin(options: ClipboardOptions = {}): Plugin {
  return new Plugin({
    key: new PluginKey("journalClipboard"),
    props: {
      // text mode copy は ProseMirror 標準に任せつつ、外部へ出る HTML から ID を剥がす
      transformCopied: (slice) => mapSliceNodes(slice, stripIds),
      // 外部・copy 由来 paste は ID 再発行（重複 ID は normalizer の防衛もある）
      transformPasted: (slice) => mapSliceNodes(slice, reissueIds),

      handleDOMEvents: {
        copy(view, event) {
          const containers = selectedContainers(view);
          if (containers.length === 0) return false;
          writeBlocksToClipboard(event, containers, options.sourceNoteId);
          return true;
        },
        cut(view, event) {
          const containers = selectedContainers(view);
          if (containers.length === 0) return false;
          // cut は元ブロックを削除するので sourceNoteId を載せない。載せると paste-and-sync
          // が「消えたブロック」を指す dangling ミラーになる（cut は move であって参照元にならない）。
          writeBlocksToClipboard(event, containers);
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
        const syncEligible =
          options.syncPasteEnabled &&
          !!sourceNoteId &&
          originals.every((container) => container.attrs.id !== null);
        if (syncEligible && sourceNoteId) {
          openPasteMenu(tr, {
            start,
            plain,
            synced: buildSyncedContainers(originals, sourceNoteId),
          });
        }
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}
