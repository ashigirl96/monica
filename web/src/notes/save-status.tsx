import { useAutosaveContext } from "./autosave-context";

/** ヘッダ行に出す保存状態。競合（409）は保存失敗より強く、リトライでは解けないので
 * 読み直しの導線を添えて優先表示する。状態は note id で autosave から引く — autosave は
 * アプリ全体で 1 つなので、別 note の失敗をこの行に出さないよう id で絞る必要がある。 */
export function SaveStatus({ noteId, onReload }: { noteId: string; onReload: () => void }) {
  const { hasConflict, saveError } = useAutosaveContext();
  if (hasConflict(noteId)) {
    return (
      <span className="flex items-center gap-2 text-destructive">
        別の場所でこのノートが更新されました
        <button
          type="button"
          onClick={onReload}
          className="rounded border border-current px-1.5 py-0.5 hover:bg-destructive/10"
        >
          最新を読み込む
        </button>
      </span>
    );
  }
  const error = saveError(noteId);
  if (error !== null) {
    return (
      <span className="truncate text-destructive" title={error}>
        Failed to save — changes retry on next edit
      </span>
    );
  }
  return null;
}
