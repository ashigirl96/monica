import { type RefObject, useEffect, useRef } from "react";
import { TextSelection } from "@milkdown/kit/prose/state";
import { createBlockEditor } from "./create-editor";
import type { FetchLinkMetadata } from "./link-menu";
import "./block-editor.css";

export type BlockEditorHandle = {
  /** 文書先頭にカーソルを置いてフォーカスする（タイトル → 本文の移動用） */
  focusStart: () => void;
};

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
  onUnmount,
  handleRef,
  className,
}: BlockEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const initialDocRef = useRef(initialDoc);
  const autoFocusRef = useRef(autoFocus);
  const onDocChangeRef = useRef(onDocChange);
  onDocChangeRef.current = onDocChange;
  const onExitUpRef = useRef(onExitUp);
  onExitUpRef.current = onExitUp;
  const hasExitUp = onExitUp !== undefined;
  const fetchLinkMetadataRef = useRef(fetchLinkMetadata);
  fetchLinkMetadataRef.current = fetchLinkMetadata;
  const hasFetchLinkMetadata = fetchLinkMetadata !== undefined;
  const onUnmountRef = useRef(onUnmount);
  onUnmountRef.current = onUnmount;
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
