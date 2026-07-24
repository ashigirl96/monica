import { useEffect, useState } from "react";
import { getNote } from "@/api";
import { navigate } from "@/app";

/**
 * 旧 `/notes` の後継リダイレクト。`/notes` は `/daily` へ、`/notes/{id}` は note の kind に
 * 応じた新 URL へ飛ばす。既存ノート本文の mention href（`/notes/{id}`）が永続化されている
 * ため、ルート自体は恒久的に温存してここで振り分ける。
 */
export function NoteRedirect({ id }: { id: string | null }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === null) {
      navigate("/daily", { replace: true });
      return;
    }
    let cancelled = false;
    getNote(id)
      .then((note) => {
        if (cancelled) return;
        const kind = note.kind;
        if (kind.kind === "essay") navigate(`/essays/${note.id}`, { replace: true });
        else if (kind.kind === "project")
          navigate(`/projects/${kind.project_id}/notes/${note.id}`, { replace: true });
        else navigate(`/daily/${note.date}`, { replace: true });
      })
      .catch(() => {
        if (!cancelled) setError("Note not found");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="notes-screen flex h-dvh items-center justify-center bg-[var(--paper)]">
      <p className="text-sm text-[var(--ink-faint)]">{error ?? "Opening…"}</p>
    </div>
  );
}
