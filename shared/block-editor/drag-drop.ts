import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { nodes, reissueIds } from "./schema";
import { containerById, getBlockContext, rangeFromIds, rangePositions } from "./context";
import { blockSelectionKey, selectBlocks } from "./selection-state";
import { BLOCKS_MIME, blocksToPlainText, serializeBlocksPayload } from "./clipboard";

type DropZone = "before" | "after" | "as-child";
type DropTarget = { targetId: string; zone: DropZone };

// journal エディタは同時に 1 つしか drag できないため module-level で十分
let activeDrag: { ids: string[] } | null = null;

export function beginHandleDrag(
  view: EditorView,
  id: string,
  event: DragEvent,
  dragImage: HTMLElement,
): void {
  const selection = blockSelectionKey.getState(view.state);
  const ids = selection && selection.selectedIds.includes(id) ? selection.selectedIds : [id];
  if (ids.length === 1 && (!selection || !selection.selectedIds.includes(id))) {
    view.dispatch(selectBlocks(view.state.tr, id, id));
  }
  const containers = ids
    .map((blockId) => containerById(view.state.doc, blockId)?.node)
    .filter((node): node is PMNode => node !== undefined && node !== null);
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData(BLOCKS_MIME, serializeBlocksPayload(containers, "move"));
  event.dataTransfer.setData("text/plain", blocksToPlainText(containers));
  event.dataTransfer.setDragImage(dragImage, 0, 0);
  activeDrag = { ids };
}

const AS_CHILD_X_THRESHOLD = 48;

function computeDropTarget(view: EditorView, event: DragEvent): DropTarget | null {
  const found = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!found) return null;
  const ctx = getBlockContext(view.state.doc.resolve(found.pos));
  if (!ctx) return null;
  const targetId = ctx.containerNode.attrs.id as string | null;
  if (!targetId) return null;
  const dom = view.nodeDOM(ctx.containerPos);
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  if (rect.height === 0) return null;
  // §8.2: Y 上部 25% = before / 下部 25% = after / 中央 50% で X が閾値より右 = as-child
  const relY = (event.clientY - rect.top) / rect.height;
  if (relY < 0.25) return { targetId, zone: "before" };
  if (relY > 0.75) return { targetId, zone: "after" };
  if (event.clientX > rect.left + AS_CHILD_X_THRESHOLD) return { targetId, zone: "as-child" };
  return { targetId, zone: relY < 0.5 ? "before" : "after" };
}

// §8.3: 自分自身または自分の子孫へは drop 不可
function isInsideDragged(state: EditorState, ids: readonly string[], targetPos: number): boolean {
  const range = rangeFromIds(state, ids);
  if (!range) return true;
  const { start, end } = rangePositions(range);
  return targetPos >= start && targetPos < end;
}

export function dropBlocks(
  state: EditorState,
  ids: readonly string[],
  target: DropTarget,
  copy: boolean,
): Transaction | null {
  const targetEntry = containerById(state.doc, target.targetId);
  if (!targetEntry) return null;
  if (!copy && isInsideDragged(state, ids, targetEntry.pos)) return null;
  const range = rangeFromIds(state, ids);
  if (!range) return null;

  let moved: PMNode[] = [];
  for (let i = range.fromIndex; i <= range.toIndex; i++) moved.push(range.groupNode.child(i));
  if (copy) moved = moved.map(reissueIds);

  const tr = state.tr;
  if (!copy) {
    const { start, end } = rangePositions(range);
    const wholeGroup = range.fromIndex === 0 && range.toIndex === range.groupNode.childCount - 1;
    if (wholeGroup && range.parentContainerPos !== null) {
      tr.delete(range.groupPos, range.groupPos + range.groupNode.nodeSize);
    } else {
      tr.delete(start, end);
    }
  }

  // 削除後の doc から挿入先を ID で引き直す（position mapping 不要）
  const fresh = containerById(tr.doc, target.targetId);
  if (!fresh) return null;
  if (target.zone === "before") {
    tr.insert(fresh.pos, moved);
  } else if (target.zone === "after") {
    tr.insert(fresh.pos + fresh.node.nodeSize, moved);
  } else {
    const content = fresh.node.child(0);
    if (content.type === nodes.divider) return null;
    if (fresh.node.childCount > 1) {
      const groupPos = fresh.pos + 1 + content.nodeSize;
      tr.insert(groupPos + fresh.node.child(1).nodeSize - 1, moved);
    } else {
      tr.insert(fresh.pos + 1 + content.nodeSize, nodes.blockGroup.create(null, moved));
    }
    // collapsed toggle へ child drop したら開く（§8.3）
    if (content.type === nodes.toggle && content.attrs.open === false) {
      tr.setNodeAttribute(fresh.pos + 1, "open", true);
    }
  }
  // §8.3: drop 後も移動した block 群の選択を維持
  selectBlocks(tr, moved[0].attrs.id as string, moved[moved.length - 1].attrs.id as string);
  return tr.setMeta("blockOperation", { type: copy ? "copy-drag" : "move" });
}

export function dragDropPlugin(): Plugin {
  let dropTarget: DropTarget | null = null;

  return new Plugin({
    key: new PluginKey("journalDragDrop"),
    view(view) {
      const guide = document.createElement("div");
      guide.className = "jb-drop-guide";
      guide.style.display = "none";
      view.dom.parentElement?.append(guide);

      const hide = () => {
        dropTarget = null;
        guide.style.display = "none";
      };

      const show = (target: DropTarget) => {
        const wrapper = view.dom.parentElement;
        const entry = containerById(view.state.doc, target.targetId);
        if (!wrapper || !entry) return hide();
        const dom = view.nodeDOM(entry.pos);
        if (!(dom instanceof HTMLElement)) return hide();
        const rect = dom.getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        // CSS zoom 下では client 座標と layout 座標がずれるため比率で補正する
        const scale = wrapper.offsetWidth > 0 ? wrapperRect.width / wrapper.offsetWidth : 1;
        const indent = target.zone === "as-child" ? 24 : 0;
        const y = target.zone === "before" ? rect.top : rect.bottom;
        guide.style.display = "block";
        guide.style.left = `${(rect.left - wrapperRect.left) / scale + indent}px`;
        guide.style.top = `${(y - wrapperRect.top) / scale - 1}px`;
        guide.style.width = `${rect.width / scale - indent}px`;
      };

      const editorDom = view.dom;
      const onDragOver = (e: DragEvent) => {
        if (!activeDrag) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
        const target = computeDropTarget(view, e);
        if (
          target &&
          !(
            !e.altKey &&
            isInsideDragged(
              view.state,
              activeDrag.ids,
              containerById(view.state.doc, target.targetId)?.pos ?? -1,
            )
          )
        ) {
          dropTarget = target;
          show(target);
        } else {
          hide();
        }
      };
      const onDrop = (e: DragEvent) => {
        if (!activeDrag || !dropTarget) return;
        e.preventDefault();
        const tr = dropBlocks(view.state, activeDrag.ids, dropTarget, e.altKey);
        if (tr) view.dispatch(tr.scrollIntoView());
        activeDrag = null;
        hide();
      };
      const onDragEnd = () => {
        activeDrag = null;
        hide();
      };

      editorDom.addEventListener("dragover", onDragOver);
      editorDom.addEventListener("drop", onDrop);
      window.addEventListener("dragend", onDragEnd);

      return {
        destroy() {
          editorDom.removeEventListener("dragover", onDragOver);
          editorDom.removeEventListener("drop", onDrop);
          window.removeEventListener("dragend", onDragEnd);
          guide.remove();
        },
      };
    },
  });
}
