import { type RefObject, useEffect, useRef } from "react";
import { TextSelection } from "@milkdown/kit/prose/state";
import { createBlockEditor } from "./create-editor";
import type { FetchLinkMetadata } from "./link-menu";
import type { SearchNoteMentions } from "./note-mention-menu";
import type { OnNoteMentionClick, ResolveNoteMention } from "./node-views";
import "./block-editor.css";

export type BlockEditorHandle = {
  /** 文書先頭にカーソルを置いてフォーカスする（タイトル → 本文の移動用） */
  focusStart: () => void;
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
  const onUnmountRef = useLatest(onUnmount);
  // callback の有無は plugin / keymap の登録可否を決めるため mount 時に固定される
  const hasExitUp = onExitUp !== undefined;
  const hasFetchLinkMetadata = fetchLinkMetadata !== undefined;
  const hasSearchNoteMentions = searchNoteMentions !== undefined;
  const hasResolveNoteMention = resolveNoteMention !== undefined;
  // initialDoc 等と同じく mount 時に一度だけ読む（差し替えは想定しない）
  const handleRefAtMount = useRef(handleRef);

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
    });

    const handle = handleRefAtMount.current;
    if (handle) {
      handle.current = {
        focusStart: () => {
          view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
          view.focus();
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

  return (
    <div ref={rootRef} className={className ? `jb-root ${className}` : "jb-root"}>
      <div ref={hostRef} className="relative" />
    </div>
  );
}
