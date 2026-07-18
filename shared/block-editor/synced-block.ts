import { DOMSerializer, Node as PMNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { nodes, schema } from "./schema";
import { containerById } from "./context";
import { el } from "./node-views";

/** (noteId, blockId) → 元 blockContainer subtree の ProseMirror JSON。
    null = 元ブロックが存在しない（dangling）。reject = 通信エラー。 */
export type ResolveBlock = (noteId: string, blockId: string) => Promise<unknown | null>;
export type OnOpenBlock = (noteId: string, blockId: string) => void;

export type SyncedBlockOptions = {
  /** 現在編集中の note。参照先がこれと一致すれば live doc から即時解決する。 */
  noteId?: string;
  resolveBlock?: ResolveBlock;
  onOpenBlock?: OnOpenBlock;
};

// ミラー本体を静的描画する serializer。schema の toDOM をベースに 2 点だけ差し替える:
// 1. blockContainer の data-block-id を出さない（参照元と同じ ID が DOM 内に重複し、
//    ID ベースの DOM lookup が誤ヒットするのを防ぐ）
// 2. ネストした syncedBlock はプレースホルダにする（解決を 1 段で止め、自己参照・
//    循環でも無限再帰・fetch 連鎖を起こさない）
const mirrorSerializer = new DOMSerializer(
  {
    ...DOMSerializer.nodesFromSchema(schema),
    blockContainer: () => ["div", { "data-block-container": "" }, 0],
    syncedBlock: () => ["div", { class: "jb-synced-nested" }, "Nested synced block"],
  },
  DOMSerializer.marksFromSchema(schema),
);

function sameSources(a: readonly (PMNode | null)[], b: readonly (PMNode | null)[]): boolean {
  return a.length === b.length && a.every((node, i) => node === b[i]);
}

export class SyncedBlockView implements NodeView {
  dom: HTMLElement;
  private body: HTMLElement;
  private destroyed = false;
  // 同一ノート内参照のライブ反映用。前回描画した source ノード列（未変更なら同一参照）。
  private lastSources: (PMNode | null)[] = [];
  readonly noteId: string;
  readonly blockIds: string[];

  constructor(
    private node: PMNode,
    private view: EditorView,
    private opts: SyncedBlockOptions,
    private registry: Set<SyncedBlockView>,
  ) {
    this.noteId = node.attrs.noteId as string;
    this.blockIds = node.attrs.blockIds as string[];

    this.dom = el("div", "jb-synced");
    this.dom.contentEditable = "false";

    const header = el("div", "jb-synced-header");
    header.append(el("span", "jb-synced-label", (span) => (span.textContent = "Synced")));
    const jump = el("button", "jb-synced-jump", (btn) => {
      btn.type = "button";
      btn.tabIndex = -1;
      btn.textContent = "↗";
      btn.title = "Go to original block";
      btn.setAttribute("aria-label", "Go to original block");
    });
    jump.addEventListener("mousedown", (e) => e.preventDefault());
    jump.addEventListener("click", (e) => {
      e.preventDefault();
      // まとめ synced block では先頭ブロックへジャンプする
      const first = this.blockIds[0];
      if (first) this.opts.onOpenBlock?.(this.noteId, first);
    });
    header.append(jump);

    this.body = el("div", "jb-synced-body");
    this.dom.append(header, this.body);

    this.registry.add(this);
    this.load();
  }

  private isSameNote(): boolean {
    return !!this.opts.noteId && this.noteId === this.opts.noteId;
  }

  private load(): void {
    if (this.isSameNote()) {
      this.renderFromLiveDoc();
      return;
    }
    if (!this.opts.resolveBlock) {
      this.renderMessage("jb-synced-error", "Synced block unavailable");
      return;
    }
    const resolve = this.opts.resolveBlock;
    this.renderLoading();
    Promise.all(this.blockIds.map((blockId) => resolve(this.noteId, blockId)))
      .then((results) => {
        if (this.destroyed) return;
        const found = results.filter((json): json is unknown => json != null);
        if (found.length === 0) this.renderDangling();
        else this.renderResolved(found);
      })
      .catch(() => {
        if (this.destroyed) return;
        this.renderError();
      });
  }

  /** refresh plugin から docChanged 時に呼ばれる。参照先ノード列の identity が
      変わったときだけ再描画する（PM の永続構造で未変更 subtree は同一参照）。 */
  refreshFromDoc(): void {
    if (!this.isSameNote()) return;
    const sources = this.blockIds.map(
      (blockId) => containerById(this.view.state.doc, blockId)?.node ?? null,
    );
    if (sameSources(sources, this.lastSources)) return;
    this.renderFromLiveDoc();
  }

  private renderFromLiveDoc(): void {
    const sources = this.blockIds.map(
      (blockId) => containerById(this.view.state.doc, blockId)?.node ?? null,
    );
    this.lastSources = sources;
    const found = sources.filter((node): node is PMNode => node !== null);
    if (found.length === 0) {
      this.renderDangling();
      return;
    }
    this.renderNodes(found);
  }

  private renderResolved(jsons: unknown[]): void {
    const parsed: PMNode[] = [];
    try {
      for (const json of jsons) parsed.push(PMNode.fromJSON(schema, json));
    } catch {
      this.renderError();
      return;
    }
    this.renderNodes(parsed);
  }

  private renderNodes(containers: readonly PMNode[]): void {
    const frag = document.createDocumentFragment();
    for (const container of containers) frag.append(mirrorSerializer.serializeNode(container));
    this.body.replaceChildren(frag);
  }

  private renderLoading(): void {
    const wrap = el("div", "jb-synced-loading");
    wrap.append(el("span", "jb-synced-spinner"), document.createTextNode("Loading…"));
    this.body.replaceChildren(wrap);
  }

  private renderDangling(): void {
    this.renderMessage("jb-synced-dangling", "Original block was deleted");
  }

  private renderError(): void {
    const wrap = el("div", "jb-synced-error", (div) => {
      div.textContent = "Failed to load synced block";
    });
    const retry = el("button", "jb-synced-error-retry", (btn) => {
      btn.type = "button";
      btn.tabIndex = -1;
      btn.textContent = "Retry";
    });
    retry.addEventListener("mousedown", (e) => e.preventDefault());
    retry.addEventListener("click", (e) => {
      e.preventDefault();
      this.load();
    });
    wrap.append(retry);
    this.body.replaceChildren(wrap);
  }

  private renderMessage(className: string, text: string): void {
    this.body.replaceChildren(
      el("div", className, (div) => {
        div.textContent = text;
      }),
    );
  }

  update(node: PMNode): boolean {
    // 参照先（noteId/blockId）が同じなら再構築しない。変われば false で作り直す。
    if (node.type !== nodes.syncedBlock || !node.sameMarkup(this.node)) return false;
    this.node = node;
    return true;
  }

  // stopEvent / ignoreMutation は既定に委ねる（bookmark/linkMention と同じ atom 規約）。
  // contentDOM を持たない node view はミラー内の非同期 DOM 変更を既定で無視し、クリックは
  // ProseMirror に届いて node selection（選択 → 削除）が効く。

  destroy(): void {
    this.destroyed = true;
    this.registry.delete(this);
  }
}

/** 同一ノート内 synced block のライブ反映。docChanged のたびに registry を走査し、
    参照先が変わった view だけ DOM を更新する（transaction は発行しない）。 */
export function syncedBlockRefreshPlugin(registry: Set<SyncedBlockView>): Plugin {
  return new Plugin({
    key: new PluginKey("syncedBlockRefresh"),
    view() {
      return {
        update(view, prevState) {
          if (view.state.doc === prevState.doc) return;
          for (const syncedView of registry) syncedView.refreshFromDoc();
        },
      };
    },
  });
}
