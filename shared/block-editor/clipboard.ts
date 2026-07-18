import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { DOMSerializer, Fragment, Node as PMNode, Slice } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { nodes, reissueIds, schema } from "./schema";
import { containerById, getBlockContext, rangeFromIds, rangePositions } from "./context";
import { deleteRange } from "./commands";
import { blockSelectionKey } from "./selection-state";
import { openLinkMenu } from "./link-menu";
import { internalNoteId } from "./note-mention-menu";
import { noteMentionMenuKey } from "./menu-keys";

// TODO.md §8.4 / §10.1
export const BLOCKS_MIME = "application/x-monica-blocks+json";

type BlocksPayload = {
  schemaVersion: 1;
  operation: "copy" | "move";
  blocks: unknown[];
};

export function serializeBlocksPayload(
  containers: readonly PMNode[],
  operation: "copy" | "move",
): string {
  const payload: BlocksPayload = {
    schemaVersion: 1,
    operation,
    blocks: containers.map((node) => node.toJSON() as unknown),
  };
  return JSON.stringify(payload);
}

export function blocksToPlainText(containers: readonly PMNode[]): string {
  const lines: string[] = [];
  const walk = (container: PMNode, depth: number) => {
    const content = container.child(0);
    const text =
      content.type === nodes.divider
        ? "---"
        : content.content.textBetween(0, content.content.size, undefined, "\n");
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

function parseBlocksPayload(raw: string): PMNode[] | null {
  let payload: BlocksPayload;
  try {
    payload = JSON.parse(raw) as BlocksPayload;
  } catch {
    return null;
  }
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.blocks)) return null;
  try {
    // paste は常に copy 扱い: ID を全再発行する（TODO.md §10.3）
    return payload.blocks.map((json) => reissueIds(PMNode.fromJSON(schema, json)));
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

function pastedUrl(event: ClipboardEvent): string | null {
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
  const mentionMenu = noteMentionMenuKey.getState(state);
  // `[[` メニュー中はプレーンテキストとして挿入させ、query に取り込む
  // （link mark + link-menu が乗ると二重メニューになる）
  if (mentionMenu?.active) return false;
  const sel = state.selection;
  const ctx = getBlockContext(sel.$from);
  if (!ctx || ctx.contentNode.type === nodes.codeBlock) return false;
  // 内部ノート URL は note mention に自動変換（plugin 登録済み = notes アプリ内のみ。
  // desktop journal は未登録なので従来どおりプレーンリンク）
  if (mentionMenu !== undefined && sel.empty) {
    const noteId = internalNoteId(url, window.location.origin);
    if (noteId) {
      const mention = nodes.noteMention.create({ noteId });
      const tr = state.tr.replaceWith(sel.from, sel.from, mention);
      tr.setSelection(TextSelection.create(tr.doc, sel.from + mention.nodeSize));
      view.dispatch(tr.scrollIntoView());
      return true;
    }
  }
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

function writeBlocksToClipboard(event: ClipboardEvent, containers: readonly PMNode[]): void {
  if (!event.clipboardData) return;
  event.preventDefault();
  event.clipboardData.setData(BLOCKS_MIME, serializeBlocksPayload(containers, "copy"));
  event.clipboardData.setData("text/html", blocksToHtml(containers));
  event.clipboardData.setData("text/plain", blocksToPlainText(containers));
}

export function clipboardPlugin(): Plugin {
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
          writeBlocksToClipboard(event, containers);
          return true;
        },
        cut(view, event) {
          const containers = selectedContainers(view);
          if (containers.length === 0) return false;
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
        const blocks = parseBlocksPayload(raw);
        if (!blocks || blocks.length === 0) return false;

        const selection = blockSelectionKey.getState(view.state);
        if (selection && selection.selectedIds.length > 0) {
          // block mode paste: 選択の直後へ挿入
          const range = rangeFromIds(view.state, selection.selectedIds);
          if (!range) return false;
          const { end } = rangePositions(range);
          view.dispatch(view.state.tr.insert(end, blocks).scrollIntoView());
          return true;
        }
        const ctx = getBlockContext(view.state.selection.$from);
        if (!ctx) return false;
        // 空 paragraph（子なし）の上なら置き換え、それ以外は直後に挿入
        const tr = view.state.tr;
        if (
          ctx.contentNode.type === nodes.paragraph &&
          ctx.contentNode.content.size === 0 &&
          ctx.containerNode.childCount === 1
        ) {
          tr.replaceWith(ctx.containerPos, ctx.containerPos + ctx.containerNode.nodeSize, blocks);
        } else {
          tr.insert(ctx.containerPos + ctx.containerNode.nodeSize, blocks);
        }
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}
