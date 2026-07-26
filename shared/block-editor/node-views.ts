import type { Node as PMNode } from "@milkdown/kit/prose/model";
import type {
  EditorView,
  NodeView,
  NodeViewConstructor,
  ViewMutationRecord,
} from "@milkdown/kit/prose/view";
import { nodes, noteHref } from "./schema";
import { imageUploadKey, requestImageRetry } from "./image-upload";
import { isCollapsedContainer, isFoldableContent, isFoldedContent } from "./folding";
import { foldTransaction } from "./commands";
import { SyncedBlockView } from "./synced-block";
import type { OnOpenBlock, ResolveBlock } from "./synced-block";

type GetPos = () => number | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  init?: (node: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  init?.(node);
  return node;
}

// ▸ 開閉ボタン。mousedown の preventDefault でエディタの selection を奪わない。
function disclosureButton(className: string, onClick: () => void): HTMLButtonElement {
  const btn = el("button", className, (b) => {
    b.type = "button";
    b.tabIndex = -1;
    b.contentEditable = "false";
    b.textContent = "▸";
  });
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return btn;
}

// TODO.md §11.1: blockContainer NodeView。折りたたみ ▾ は heading / callout のときだけ
// contenteditable=false で contentDOM の外に置く（既存 toggle は ToggleView が持つ）。
class ContainerView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private foldBtn: HTMLButtonElement;
  // 打鍵ごとに update が走るので、変化した属性だけ書いて余計な MutationRecord を出さない
  private folded: string | null = null;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: GetPos,
  ) {
    this.dom = el("div", "jb-container");
    this.contentDOM = el("div", "jb-container-body");
    this.foldBtn = disclosureButton("jb-fold-btn", () => this.toggleFold());
    this.dom.append(this.foldBtn, this.contentDOM);
    this.sync(node);
  }

  // focus はしない: カーソルが画面外にあると WebKit がそこへスクロールしてしまう
  // （▾ をクリックしただけで表示位置が飛ぶ）。ToggleView の ▸ も同じ流儀。
  private toggleFold(): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const content = this.node.child(0);
    this.view.dispatch(
      foldTransaction(this.view.state, { containerPos: pos, contentPos: pos + 1, content }),
    );
  }

  // data-folded は「折りたためる block か」も兼ねる（属性なし = ▾ を出さない）
  private syncFoldBtn(content: PMNode): void {
    const folded = isFoldableContent(content) ? String(isFoldedContent(content)) : null;
    if (folded === this.folded) return;
    this.folded = folded;
    if (folded === null) {
      this.dom.removeAttribute("data-folded");
      return;
    }
    this.dom.setAttribute("data-folded", folded);
    this.foldBtn.setAttribute("aria-expanded", String(folded === "false"));
    this.foldBtn.setAttribute(
      "aria-label",
      folded === "true" ? "Expand section" : "Collapse section",
    );
  }

  private sync(node: PMNode): void {
    this.node = node;
    const id = node.attrs.id as string | null;
    this.dom.setAttribute("data-block-container", "");
    if (id) this.dom.setAttribute("data-block-id", id);
    else this.dom.removeAttribute("data-block-id");
    const content = node.child(0);
    this.dom.classList.toggle("jb-collapsed", isCollapsedContainer(node));
    const isCallout = content.type === nodes.callout;
    this.dom.classList.toggle("jb-callout", isCallout);
    if (isCallout) this.dom.setAttribute("data-callout-kind", content.attrs.kind as string);
    else this.dom.removeAttribute("data-callout-kind");
    this.syncFoldBtn(content);
  }

  update(node: PMNode): boolean {
    if (node.type !== nodes.blockContainer) return false;
    this.sync(node);
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.foldBtn.contains(event.target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    // WebKit の IME 確定 (deleteCompositionText) は空になった block を祖先ごと畳み、
    // contentDOM を除去して container 直下に br や確定文字入りの span を撒くことが
    // ある（Safari regression。commands.ts の ignoreCompositionEnter と同族）。
    // この mutation は contentDOM の外なので PM からは見えず、放置すると DOM だけが
    // 壊れて state と乖離する。doc は composition 中の transaction で既に確定文字列と
    // 一致しているため、contentDOM を戻して撒かれたノードを捨てれば再一致する。
    if (mutation.type === "childList" && mutation.target === this.dom) {
      let repaired = false;
      if ([...mutation.removedNodes].includes(this.contentDOM)) {
        this.dom.append(this.contentDOM);
        repaired = true;
      }
      for (const added of mutation.addedNodes) {
        if (added === this.contentDOM || added === this.foldBtn) continue;
        const hadSelection = added.contains(document.getSelection()?.anchorNode ?? null);
        (added as ChildNode).remove();
        // 捨てたノードに DOM selection が居た場合は state の selection へ戻す
        if (hadSelection) queueMicrotask(() => this.view.focus());
        repaired = true;
      }
      if (repaired) return true;
    }
    return !(mutation.target instanceof Node && this.contentDOM.contains(mutation.target));
  }
}

// TODO.md §11.2: todo checkbox は contenteditable=false、クリックで checked を更新。
class TodoView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private checkbox: HTMLButtonElement;

  constructor(
    private node: PMNode,
    view: EditorView,
    getPos: GetPos,
  ) {
    this.dom = el("div", "jb-todo");
    this.dom.setAttribute("data-block-content", "todo");
    this.checkbox = el("button", "jb-todo-checkbox", (btn) => {
      btn.type = "button";
      btn.tabIndex = -1;
      btn.contentEditable = "false";
      btn.setAttribute("role", "checkbox");
    });
    this.checkbox.addEventListener("mousedown", (e) => e.preventDefault());
    this.checkbox.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      view.dispatch(view.state.tr.setNodeAttribute(pos, "checked", !this.node.attrs.checked));
    });
    this.contentDOM = el("div", "jb-todo-text");
    this.dom.append(this.checkbox, this.contentDOM);
    this.sync(node);
  }

  private sync(node: PMNode): void {
    this.node = node;
    const checked = node.attrs.checked === true;
    this.dom.setAttribute("data-checked", String(checked));
    this.checkbox.setAttribute("aria-checked", String(checked));
    this.checkbox.textContent = checked ? "✓" : "";
  }

  update(node: PMNode): boolean {
    if (node.type !== nodes.todo) return false;
    this.sync(node);
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.checkbox.contains(event.target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !(mutation.target instanceof Node && this.contentDOM.contains(mutation.target));
  }
}

class ToggleView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private button: HTMLButtonElement;

  constructor(
    private node: PMNode,
    view: EditorView,
    getPos: GetPos,
  ) {
    this.dom = el("div", "jb-toggle");
    this.dom.setAttribute("data-block-content", "toggle");
    // 生の attr 反転だと、閉じる瞬間にカーソルが配下にいた場合 normalizer の
    // 不可視カーソル救済が畳みを開き戻す。foldTransaction が選択を退避してくれる。
    this.button = disclosureButton("jb-toggle-btn", () => {
      const pos = getPos();
      if (pos === undefined) return;
      view.dispatch(
        foldTransaction(view.state, { containerPos: pos - 1, contentPos: pos, content: this.node }),
      );
    });
    this.contentDOM = el("div", "jb-toggle-text");
    this.dom.append(this.button, this.contentDOM);
    this.sync(node);
  }

  private sync(node: PMNode): void {
    this.node = node;
    const open = node.attrs.open !== false;
    this.dom.setAttribute("data-open", String(open));
    this.button.setAttribute("aria-expanded", String(open));
  }

  update(node: PMNode): boolean {
    if (node.type !== nodes.toggle) return false;
    this.sync(node);
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.button.contains(event.target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !(mutation.target instanceof Node && this.contentDOM.contains(mutation.target));
  }
}

const CODE_LANGUAGES = [
  "plain text",
  "typescript",
  "javascript",
  "rust",
  "python",
  "go",
  "sql",
  "json",
  "yaml",
  "toml",
  "html",
  "css",
  "shell",
  "markdown",
];

class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private toolbar: HTMLElement;
  private select: HTMLSelectElement;
  private wrapButton: HTMLButtonElement;

  constructor(
    private node: PMNode,
    view: EditorView,
    getPos: GetPos,
  ) {
    this.dom = el("div", "jb-code");
    this.select = el("select", "jb-code-language");
    for (const lang of CODE_LANGUAGES) {
      const option = document.createElement("option");
      option.value = lang;
      option.textContent = lang;
      this.select.append(option);
    }
    this.select.addEventListener("change", () => {
      const pos = getPos();
      if (pos === undefined) return;
      view.dispatch(view.state.tr.setNodeAttribute(pos, "language", this.select.value));
    });
    const copy = el("button", "jb-code-btn", (btn) => {
      btn.type = "button";
      btn.tabIndex = -1;
      btn.textContent = "copy";
    });
    copy.addEventListener("click", (e) => {
      e.preventDefault();
      void navigator.clipboard.writeText(this.node.textContent);
    });
    this.wrapButton = el("button", "jb-code-btn", (btn) => {
      btn.type = "button";
      btn.tabIndex = -1;
      btn.textContent = "wrap";
    });
    this.wrapButton.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      view.dispatch(view.state.tr.setNodeAttribute(pos, "wrap", this.node.attrs.wrap !== true));
    });
    this.toolbar = el("div", "jb-code-toolbar", (bar) => {
      bar.contentEditable = "false";
      bar.append(this.select, this.wrapButton, copy);
    });
    const pre = el("pre", "jb-code-pre");
    this.contentDOM = document.createElement("code");
    pre.append(this.contentDOM);
    this.dom.append(this.toolbar, pre);
    this.sync(node);
  }

  private sync(node: PMNode): void {
    this.node = node;
    this.select.value = node.attrs.language as string;
    const wrap = node.attrs.wrap === true;
    this.dom.classList.toggle("jb-code-wrap", wrap);
    this.wrapButton.classList.toggle("jb-code-btn-active", wrap);
  }

  update(node: PMNode): boolean {
    if (node.type !== nodes.codeBlock) return false;
    this.sync(node);
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.toolbar.contains(event.target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !(mutation.target instanceof Node && this.contentDOM.contains(mutation.target));
  }
}

class DividerView implements NodeView {
  dom: HTMLElement;

  constructor() {
    this.dom = el("div", "jb-divider");
    this.dom.setAttribute("data-block-content", "divider");
    this.dom.append(document.createElement("hr"));
  }

  update(node: PMNode): boolean {
    return node.type === nodes.divider;
  }
}

// contenteditable 内の <a> はブラウザがナビゲーションを握り潰すため明示的に開く
export function openExternal(href: string): void {
  window.open(href, "_blank", "noopener");
}

function openHref(anchor: HTMLAnchorElement, href: string): void {
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.addEventListener("click", (e) => {
    e.preventDefault();
    openExternal(href);
  });
}

function faviconImg(src: string): HTMLImageElement {
  const img = el("img", "jb-favicon", (image) => {
    image.src = src;
    image.alt = "";
  });
  img.addEventListener("error", () => {
    img.style.display = "none";
  });
  return img;
}

export class LinkMentionView implements NodeView {
  dom: HTMLElement;

  constructor(private node: PMNode) {
    const anchor = el("a", "jb-mention");
    anchor.contentEditable = "false";
    anchor.dataset.mention = "";
    openHref(anchor, node.attrs.href as string);
    const favicon = node.attrs.favicon as string | null;
    if (favicon) anchor.append(faviconImg(favicon));
    anchor.append(
      el("span", "jb-mention-title", (span) => {
        span.textContent = (node.attrs.title as string) || (node.attrs.href as string);
      }),
    );
    this.dom = anchor;
  }

  update(node: PMNode): boolean {
    // link-menu の preview 中に metadata 到着で attrs が差し替わる → false で再構築
    return node.type === nodes.linkMention && node.sameMarkup(this.node);
  }
}

export type NoteMentionInfo = { displayName: string };
/** noteId → 表示名。null = リンク先ノートが存在しない（削除済み含む）。 */
export type ResolveNoteMention = (noteId: string) => Promise<NoteMentionInfo | null>;
export type OnNoteMentionClick = (noteId: string) => void;

class NoteMentionView implements NodeView {
  dom: HTMLElement;
  private destroyed = false;

  constructor(
    private node: PMNode,
    opts: EditorNodeViewOptions,
  ) {
    const noteId = node.attrs.noteId as string;
    const href = noteHref(noteId);
    const anchor = el("a", "jb-mention jb-note-mention");
    anchor.contentEditable = "false";
    anchor.dataset.noteMention = noteId;
    anchor.href = href;
    // contenteditable 内の <a> はブラウザがナビゲーションを握り潰すため明示的に処理する。
    // 素クリックは SPA 遷移（callback）、modifier click は新規タブ。
    anchor.addEventListener("click", (e) => {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) window.open(href, "_blank", "noopener");
      else opts.onNoteMentionClick?.(noteId);
    });
    const title = el("span", "jb-mention-title", (span) => {
      span.textContent = noteId; // 解決までのフォールバック（callback 不在時はこのまま）
    });
    anchor.append(title);
    this.dom = anchor;
    opts
      .resolveNoteMention?.(noteId)
      .then((info) => {
        if (this.destroyed) return;
        if (info) {
          title.textContent = info.displayName;
        } else {
          title.textContent = "Deleted note";
          anchor.classList.add("jb-note-mention-dangling");
        }
      })
      .catch(() => {});
  }

  update(node: PMNode): boolean {
    // noteId が同じなら再構築しない（再構築 = 表示名の再解決になるため）
    return node.type === nodes.noteMention && node.sameMarkup(this.node);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

export class BookmarkView implements NodeView {
  dom: HTMLElement;

  constructor(private node: PMNode) {
    this.dom = el("div", "jb-bookmark");
    this.dom.setAttribute("data-block-content", "bookmark");
    this.dom.contentEditable = "false";

    const href = node.attrs.href as string;
    const card = el("a", "jb-bookmark-card");
    openHref(card, href);

    const thumbnail = node.attrs.thumbnail as string | null;
    if (thumbnail) {
      const thumb = el("div", "jb-bookmark-thumb");
      const img = el("img", "jb-bookmark-img", (image) => {
        image.src = thumbnail;
        image.alt = "";
      });
      img.addEventListener("error", () => thumb.remove());
      thumb.append(img);
      card.append(thumb);
    }

    const body = el("div", "jb-bookmark-body");
    const titleRow = el("div", "jb-bookmark-title");
    const favicon = node.attrs.favicon as string | null;
    if (favicon) titleRow.append(faviconImg(favicon));
    titleRow.append(
      el("span", "jb-bookmark-title-text", (span) => {
        span.textContent = (node.attrs.title as string) || href;
      }),
    );
    body.append(titleRow);
    const description = node.attrs.description as string | null;
    if (description) {
      body.append(
        el("div", "jb-bookmark-desc", (div) => {
          div.textContent = description;
        }),
      );
    }
    body.append(
      el("div", "jb-bookmark-url", (div) => {
        div.textContent = href;
      }),
    );
    card.append(body);
    this.dom.append(card);
  }

  update(node: PMNode): boolean {
    return node.type === nodes.bookmark && node.sameMarkup(this.node);
  }
}

const IMAGE_MIN_WIDTH = 96;

export class ImageView implements NodeView {
  dom: HTMLElement;
  private retryBtn: HTMLElement | null = null;
  private img: HTMLImageElement | null = null;
  private resizing = false;
  private closeLightbox: (() => void) | null = null;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: GetPos,
  ) {
    this.dom = el("div", "jb-image");
    this.dom.setAttribute("data-block-content", "image");
    this.dom.contentEditable = "false";
    this.render(node);
  }

  // src 解決: 確定 URL > アップロード中の ObjectURL > 復元不能プレースホルダ。
  // doc に blob: を入れない設計なので、アップロード中の実画像は plugin state 経由で引く。
  private resolveSrc(node: PMNode): string | null {
    const src = node.attrs.src as string | null;
    if (src) return src;
    const uploadId = node.attrs.uploadId as string | null;
    if (uploadId) {
      const entry = imageUploadKey.getState(this.view.state)?.get(uploadId);
      if (entry) return entry.objectUrl;
    }
    return null;
  }

  private render(node: PMNode): void {
    this.dom.replaceChildren();
    this.retryBtn = null;
    this.img = null;
    const src = this.resolveSrc(node);
    if (src) {
      const width = node.attrs.width as number | null;
      const frame = el("div", "jb-image-frame");
      const img = el("img", "jb-image-img", (image) => {
        image.src = src;
        image.alt = "";
        if (width) image.style.width = `${width}px`;
      });
      img.addEventListener("click", () => this.openLightbox(src));
      frame.append(img);
      frame.append(this.buildResizeHandle());
      this.img = img;
      this.dom.append(frame);
    } else {
      this.dom.append(
        el("div", "jb-image-placeholder", (div) => {
          div.textContent = "Image unavailable";
        }),
      );
    }
    this.syncStatus(node);
  }

  private buildResizeHandle(): HTMLElement {
    const handle = el("div", "jb-image-resize");
    handle.addEventListener("pointerdown", (e) => this.beginResize(e));
    return handle;
  }

  // ドラッグ中は inline style だけ更新し、pointerup で一度だけ attrs.width に commit する
  // （中間状態を transaction にしないことで undo を「1 リサイズ = 1 ステップ」に保つ）。
  private beginResize(event: PointerEvent): void {
    if (!this.img) return;
    event.preventDefault();
    this.resizing = true;
    const startX = event.clientX;
    const startWidth = this.img.getBoundingClientRect().width;
    const maxWidth = this.view.dom.clientWidth || startWidth;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    let latest = startWidth;

    const onMove = (e: PointerEvent) => {
      if (!this.img) return;
      latest = Math.max(IMAGE_MIN_WIDTH, Math.min(startWidth + (e.clientX - startX), maxWidth));
      this.img.style.width = `${Math.round(latest)}px`;
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      this.resizing = false;
      const pos = this.getPos();
      if (pos === undefined) return;
      this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, "width", Math.round(latest)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  private openLightbox(src: string): void {
    if (this.resizing) return;
    const overlay = el("div", "jb-lightbox");
    overlay.append(
      el("img", "jb-lightbox-img", (image) => {
        image.src = src;
        image.alt = "";
      }),
    );
    const close = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      this.closeLightbox = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    overlay.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    this.closeLightbox = close;
    document.body.append(overlay);
  }

  // 失敗バッジ + retry ボタンの出し入れ。decoration（jb-image-uploading / -failed）class は
  // plugin の decorations prop が dom に付けるので、ここでは retry の DOM だけ同期する。
  private syncStatus(node: PMNode): void {
    const uploadId = node.attrs.uploadId as string | null;
    const entry = uploadId ? imageUploadKey.getState(this.view.state)?.get(uploadId) : undefined;
    const failed = entry?.status === "failed";
    if (failed && !this.retryBtn) {
      const btn = el("button", "jb-image-retry", (b) => {
        b.type = "button";
        b.textContent = "Retry";
      });
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (uploadId) requestImageRetry(this.view, uploadId);
      });
      this.retryBtn = btn;
      this.dom.append(btn);
    } else if (!failed && this.retryBtn) {
      this.retryBtn.remove();
      this.retryBtn = null;
    }
  }

  // handle 上の pointer 操作は ProseMirror に渡さない（リサイズが選択・ドラッグに化けるのを防ぐ）。
  stopEvent(event: Event): boolean {
    return (
      this.resizing ||
      (event.target instanceof HTMLElement && event.target.classList.contains("jb-image-resize"))
    );
  }

  update(node: PMNode): boolean {
    if (node.type !== nodes.image) return false;
    // src / width 確定は sameMarkup=false → 再構築（BookmarkView と同じ）。
    if (!node.sameMarkup(this.node)) return false;
    this.node = node;
    // markup 不変で decoration/status だけ変わる（uploading→failed）ケースを同期。
    this.syncStatus(node);
    return true;
  }

  destroy(): void {
    this.closeLightbox?.();
  }
}

export type EditorNodeViewOptions = {
  resolveNoteMention?: ResolveNoteMention;
  onNoteMentionClick?: OnNoteMentionClick;
  /** 現在編集中の note。synced block の同一ノート内参照を live doc から解決する。 */
  noteId?: string;
  resolveBlock?: ResolveBlock;
  onOpenBlock?: OnOpenBlock;
};

export function editorNodeViews(
  opts: EditorNodeViewOptions = {},
  syncedRegistry: Set<SyncedBlockView> = new Set(),
): Record<string, NodeViewConstructor> {
  return {
    blockContainer: (node, view, getPos) => new ContainerView(node, view, getPos),
    todo: (node, view, getPos) => new TodoView(node, view, getPos),
    toggle: (node, view, getPos) => new ToggleView(node, view, getPos),
    codeBlock: (node, view, getPos) => new CodeBlockView(node, view, getPos),
    divider: () => new DividerView(),
    linkMention: (node) => new LinkMentionView(node),
    noteMention: (node) => new NoteMentionView(node, opts),
    bookmark: (node) => new BookmarkView(node),
    image: (node, view, getPos) => new ImageView(node, view, getPos),
    syncedBlock: (node, view) => new SyncedBlockView(node, view, opts, syncedRegistry),
  };
}
