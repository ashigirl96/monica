import { type RefObject, useEffect } from "react";

/**
 * 右下常駐ピルの popup 共通の閉じ方: 外側 mousedown と Escape。
 *
 * Escape は capture phase で張る: bubble だと、フォーカスがエディタにあるとき
 * ProseMirror が Escape を block 選択として消費して window まで届かない。
 * open のときだけ張るので、閉じている間のエディタの Escape は奪わない。
 */
export function usePopupDismiss({
  open,
  rootRef,
  triggerRef,
  onClose,
}: {
  open: boolean;
  rootRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      // 閉じるとフォーカス中の要素が unmount され、focus が body に落ちて次の Tab が
      // ページ先頭から再開してしまう。popup 内にいたときだけ trigger へ戻す
      // （外にいるなら奪ってはいけない）
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
      onClose();
    }
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, rootRef, triggerRef, onClose]);
}
