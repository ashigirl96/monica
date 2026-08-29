/** ヘッダ行に出す保存状態。競合（409）は保存失敗より強く、リトライでは解けないので
 * 読み直しの導線を添えて優先表示する。 */
export function SaveStatus({
  saveError,
  conflict,
  onReload,
}: {
  saveError: string | null;
  conflict: boolean;
  onReload: () => void;
}) {
  if (conflict) {
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
  if (saveError !== null) {
    return (
      <span className="truncate text-destructive" title={saveError}>
        Failed to save — changes retry on next edit
      </span>
    );
  }
  return null;
}
