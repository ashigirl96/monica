import { useEffect, useState } from "react";
import { listProjects } from "@/api";
import { navigate } from "@/app";
import { ctrlOnly } from "@/keys";
import type { ProjectOption } from "@/types.gen";
import { FuzzyPickerModal } from "@/components/fuzzy-picker-modal";
import { ProjectEditor } from "./editor";
import { clearLastProject, lastProject, setLastProject } from "./support";

/** projectId 未確定（`/projects`）のときの画面。最後に開いた project を復元するか、
 * 復元できなければ project picker を自動表示する。 */
function ProjectChooser() {
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((list) => {
        if (cancelled) return;
        const saved = lastProject();
        if (saved !== null && list.some((p) => p.id === saved)) {
          navigate(`/projects/${saved}`, { replace: true });
          return;
        }
        if (saved !== null) clearLastProject();
        setProjects(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load projects");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // ⌃W で picker を開き直せる（他画面と流儀を揃えて capture phase）
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      if (ctrlOnly(e) && e.code === "KeyW") {
        e.preventDefault();
        e.stopPropagation();
        setPickerOpen(true);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const open = (projectId: string) => {
    setLastProject(projectId);
    navigate(`/projects/${projectId}`);
  };

  return (
    <div className="notes-screen h-dvh overflow-y-auto bg-[var(--paper)]">
      <div className="mx-auto w-full max-w-[760px] px-10 pt-10">
        <h1 className="font-mono text-[0.8rem] uppercase tracking-widest text-[var(--ink-muted)]">
          Project
        </h1>
        {error ? (
          <p className="mt-10 text-sm text-destructive">{error}</p>
        ) : projects !== null && projects.length === 0 ? (
          <p className="mt-10 text-sm text-[var(--ink-faint)]">
            No projects yet — add one from the CLI, then reopen this page
          </p>
        ) : (
          <p className="mt-10 text-sm text-[var(--ink-faint)]">
            Select a project to open — press ⌃W to pick
          </p>
        )}
      </div>
      {pickerOpen && projects !== null && projects.length > 0 && (
        <FuzzyPickerModal
          items={projects.map((p) => ({ key: p.id, label: p.name !== "" ? p.name : p.id }))}
          placeholder="Open project…"
          onSelect={(key) => {
            if (key !== null) open(key);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

export function ProjectsPage({
  projectId,
  noteId,
}: {
  projectId: string | null;
  noteId: string | null;
}) {
  if (projectId === null) return <ProjectChooser />;
  // project を切り替えても editor が state を作り直すよう key を張る
  return <ProjectEditor key={projectId} projectId={projectId} noteId={noteId} />;
}
