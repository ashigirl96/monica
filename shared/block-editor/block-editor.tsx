import { type RefObject, useEffect, useRef } from "react";
import { TextSelection } from "@milkdown/kit/prose/state";
import { createBlockEditor } from "./create-editor";
import type { FetchLinkMetadata } from "./link-menu";
import type { SearchNoteMentions } from "./note-mention-menu";
import type { OnNoteMentionClick, ResolveNoteMention } from "./node-views";
import type { OnOpenBlock, ResolveBlock } from "./synced-block";
import type { ImportExternalImage, UploadImage } from "./image-upload";
import type { RenderMarkdown } from "./clipboard";
import { containerById } from "./context";
import { clearBlockHighlight, highlightBlock } from "./block-highlight";
import { nodes } from "./schema";
import "./block-editor.css";

/** ジャンプ後に元ブロックのハイライトを消すまでの猶予 */
const HIGHLIGHT_MS = 1500;

export type BlockEditorHandle = {
  /** 文書先頭にカーソルを置いてフォーカスする（タイトル → 本文の移動用） */
  focusStart: () => void;
  /** id の block へスクロールし、一時ハイライトする（synced block からのジャンプ用） */
  scrollToBlock: (blockId: string) => void;
};

/** 最新の props 値を mount 時固定の callback から読むための ref（再 mount 防止） */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

type BlockEditorProps = {
  /** ProseMirror doc の JSON。mount 時に一度だけ読む */
  initialDoc?: unknown;
  autoFocus?: boolean;
  /** doc が変わるたびに現在の doc（immutable node、JSON.stringify 可能）を受け取る（autosave フック） */
  onDocChange?: (doc: unknown) => void;
  /** 文書先頭 block の最上行で ↑ が押されたとき（タイトル等へのフォーカス移動用） */
  onExitUp?: () => void;
  /** URL ペースト時の Mention/Bookmark 用メタデータ取得。未指定なら常にプレーンリンク */
  fetchLinkMetadata?: FetchLinkMetadata;
  /** `[[` メニューのノート検索。未指定なら wiki link メニューは無効 */
  searchNoteMentions?: SearchNoteMentions;
  /** noteMention チップの表示名解決。未指定なら noteId のまま表示 */
  resolveNoteMention?: ResolveNoteMention;
  /** noteMention チップの素クリック（SPA 遷移用） */
  onNoteMentionClick?: OnNoteMentionClick;
  /** 現在編集中の note の id。synced block の同一ノート内参照を live doc から解決する */
  noteId?: string;
  /** synced block（transclusion）の内容解決。未指定なら paste-and-sync は無効 */
  resolveBlock?: ResolveBlock;
  /** synced block のジャンプ（元ブロックを開く） */
  onOpenBlock?: OnOpenBlock;
  /** 画像 File を asset にアップロードする。未指定なら画像 paste / drop は無効（desktop 縮退） */
  uploadImage?: UploadImage;
  /** 外部画像 URL をローカル asset 化する（外部 HTML paste の <img> 用） */
  importExternalImage?: ImportExternalImage;
  /** 選択範囲の doc JSON を markdown へ投影する。未指定なら markdown コピーは無効（plain text 縮退） */
  renderMarkdown?: RenderMarkdown;
  /** unmount 時に最終 doc の JSON を受け取る（永続化フック） */
  onUnmount?: (docJson: unknown) => void;
  /** mount 中だけ imperative な操作（focusStart 等）を提供する */
  handleRef?: RefObject<BlockEditorHandle | null>;
  /** root に付与するクラス。幅・余白・スクロールは使う側が決める */
  className?: string;
};

export function BlockEditor({
  initialDoc = null,
  autoFocus = false,
  onDocChange,
  onExitUp,
  fetchLinkMetadata,
  searchNoteMentions,
  resolveNoteMention,
  onNoteMentionClick,
  noteId,
  resolveBlock,
  onOpenBlock,
  uploadImage,
  importExternalImage,
  renderMarkdown,
  onUnmount,
  handleRef,
  className,
}: BlockEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const initialDocRef = useRef(initialDoc);
  const autoFocusRef = useRef(autoFocus);
  const onDocChangeRef = useLatest(onDocChange);
  const onExitUpRef = useLatest(onExitUp);
  const fetchLinkMetadataRef = useLatest(fetchLinkMetadata);
  const searchNoteMentionsRef = useLatest(searchNoteMentions);
  const resolveNoteMentionRef = useLatest(resolveNoteMention);
  const onNoteMentionClickRef = useLatest(onNoteMentionClick);
  const resolveBlockRef = useLatest(resolveBlock);
  const onOpenBlockRef = useLatest(onOpenBlock);
  const uploadImageRef = useLatest(uploadImage);
  const importExternalImageRef = useLatest(importExternalImage);
  const renderMarkdownRef = useLatest(renderMarkdown);
  const onUnmountRef = useLatest(onUnmount);
  // noteId は key={note.id} 再マウント前提で mount 時に固定する（initialDoc と同じ）
  const noteIdRef = useRef(noteId);
  // callback の有無は plugin / keymap の登録可否を決めるため mount 時に固定される
  const hasExitUp = onExitUp !== undefined;
  const hasFetchLinkMetadata = fetchLinkMetadata !== undefined;
  const hasSearchNoteMentions = searchNoteMentions !== undefined;
  const hasResolveNoteMention = resolveNoteMention !== undefined;
  const hasResolveBlock = resolveBlock !== undefined;
  const hasUploadImage = uploadImage !== undefined;
  const hasRenderMarkdown = renderMarkdown !== undefined;
  // initialDoc 等と同じく mount 時に一度だけ読む（差し替えは想定しない）
  const handleRefAtMount = useRef(handleRef);

  // useLatest（カスタム ref ラッパー）と cleanup 内の最新 ref 読みを exhaustive-deps が
  // 誤検知する。エディタは mount 時に一度だけ生成し中身は ref で最新を読む設計で、
  // 依存を足すと再生成・stale コールバックが走って壊れるため deps 空が正しい。
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const root = rootRef.current;
    const host = hostRef.current;
    if (!root || !host) return;
    const view = createBlockEditor(host, initialDocRef.current, {
      onDocChange: (doc) => onDocChangeRef.current?.(doc),
      // keymap の有無は mount 時に固定される（onExitUp は付け外しせず中身だけ ref で差し替え）
      onExitUp: hasExitUp ? () => onExitUpRef.current?.() : undefined,
      fetchLinkMetadata: hasFetchLinkMetadata
        ? (url) => fetchLinkMetadataRef.current?.(url) ?? Promise.resolve(null)
        : undefined,
      searchNoteMentions: hasSearchNoteMentions
        ? (query) => searchNoteMentionsRef.current?.(query) ?? Promise.resolve([])
        : undefined,
      resolveNoteMention: hasResolveNoteMention
        ? (noteId) => resolveNoteMentionRef.current?.(noteId) ?? Promise.resolve(null)
        : undefined,
      onNoteMentionClick: (noteId) => onNoteMentionClickRef.current?.(noteId),
      noteId: noteIdRef.current,
      resolveBlock: hasResolveBlock
        ? (refNoteId, blockId) =>
            resolveBlockRef.current?.(refNoteId, blockId) ?? Promise.resolve(null)
        : undefined,
      onOpenBlock: (refNoteId, blockId) => onOpenBlockRef.current?.(refNoteId, blockId),
      // plugin 登録の可否は mount 時に固定し、実装は ref で最新を読む（再 mount 防止）
      uploadImage: hasUploadImage
        ? (file) => uploadImageRef.current?.(file) ?? Promise.resolve(null)
        : undefined,
      importExternalImage: hasUploadImage
        ? (url) => importExternalImageRef.current?.(url) ?? Promise.resolve(null)
        : undefined,
      renderMarkdown: hasRenderMarkdown
        ? (docJson) => renderMarkdownRef.current?.(docJson) ?? Promise.resolve("")
        : undefined,
    });

    const handle = handleRefAtMount.current;
    if (handle) {
      handle.current = {
        focusStart: () => {
          view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
          view.focus();
        },
        scrollToBlock: (blockId) => {
          const entry = containerById(view.state.doc, blockId);
          if (!entry) return;
          const { pos } = entry;
          const tr = view.state.tr;
          // 閉じた toggle 祖先を開かないと対象が不可視でスクロールできない。
          // setNodeAttribute は node size を変えないので pos は安定。
          const $inside = view.state.doc.resolve(pos + 1);
          for (let depth = $inside.depth; depth >= 1; depth--) {
            const ancestor = $inside.node(depth);
            if (ancestor.type !== nodes.blockContainer) continue;
            const content = ancestor.child(0);
            if (content.type === nodes.toggle && content.attrs.open === false) {
              tr.setNodeAttribute($inside.before(depth) + 1, "open", true);
            }
          }
          highlightBlock(tr, blockId);
          view.dispatch(tr);
          const dom = view.nodeDOM(pos);
          if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "center" });
          window.setTimeout(() => {
            if (view.isDestroyed) return;
            view.dispatch(clearBlockHighlight(view.state.tr));
          }, HIGHLIGHT_MS);
        },
      };
    }

    // ProseMirror が処理済み（preventDefault 済み）のキーを window listener の
    // ショートカットへ届かせない（Mod-b 等との衝突防止）
    const stopHandled = (e: KeyboardEvent) => {
      if (e.defaultPrevented) e.stopPropagation();
    };
    host.addEventListener("keydown", stopHandled);

    // 最終 block より下の余白クリックで文書末尾にカーソルを置く。
    // 余白がどの要素に属していても拾えるよう、クリック Y で判定する。
    const focusTail = (e: MouseEvent) => {
      if (host.contains(e.target as Node)) return;
      if (e.clientY < host.getBoundingClientRect().bottom) return;
      e.preventDefault();
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
      view.focus();
    };
    root.addEventListener("mousedown", focusTail);

    if (autoFocusRef.current) view.focus();
    return () => {
      onUnmountRef.current?.(view.state.doc.toJSON());
      if (handleRefAtMount.current) handleRefAtMount.current.current = null;
      root.removeEventListener("mousedown", focusTail);
      host.removeEventListener("keydown", stopHandled);
      view.destroy();
    };
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <div ref={rootRef} className={className ? `jb-root ${className}` : "jb-root"}>
      <div ref={hostRef} className="relative" />
    </div>
  );
}
