import { useEffect, useRef } from "react";
import { TextSelection } from "@milkdown/kit/prose/state";
import { createBlockEditor } from "./create-editor";
import "./block-editor.css";

type BlockEditorProps = {
  /** ProseMirror doc の JSON。mount 時に一度だけ読む */
  initialDoc?: unknown;
  autoFocus?: boolean;
  /** unmount 時に最終 doc の JSON を受け取る（永続化フック） */
  onUnmount?: (docJson: unknown) => void;
  /** root に付与するクラス。幅・余白・スクロールは使う側が決める */
  className?: string;
};

export function BlockEditor({
  initialDoc = null,
  autoFocus = false,
  onUnmount,
  className,
}: BlockEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const initialDocRef = useRef(initialDoc);
  const autoFocusRef = useRef(autoFocus);
  const onUnmountRef = useRef(onUnmount);
  onUnmountRef.current = onUnmount;

  useEffect(() => {
    const root = rootRef.current;
    const host = hostRef.current;
    if (!root || !host) return;
    const view = createBlockEditor(host, initialDocRef.current);

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
