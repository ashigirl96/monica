import { navigate } from "@/app";
import { useAutosaveContext } from "./autosave-context";
import { visibleConflicts } from "./note-ledger";

/** 開いていない note で起きた 409 を surface する常駐通知。開いている note はヘッダの
 * SaveStatus が担当するので出さない（同じことを二重に言わない）。
 * `/notes/{id}` は NoteRedirect が kind に応じて振り分けるので、戻り先の経路は増やさない。 */
export function NoteConflictNotice() {
  const { conflicts, openNoteId } = useAutosaveContext();
  const rows = visibleConflicts(conflicts, openNoteId);
  if (rows.length === 0) return null;
  return (
    <div className="fixed bottom-4 left-16 z-50 flex flex-col items-start gap-1.5">
      {rows.map((c) => (
        <div
          key={c.id}
          role="status"
          className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-background px-3 py-2 text-xs text-destructive shadow-lg"
        >
          <span className="max-w-[20rem] truncate">「{c.label}」が別の場所で更新されました</span>
          <button
            type="button"
            onClick={() => navigate(`/notes/${c.id}`)}
            className="shrink-0 rounded border border-current px-1.5 py-0.5 hover:bg-destructive/10"
          >
            開く
          </button>
        </div>
      ))}
    </div>
  );
}
