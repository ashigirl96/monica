import { useState, useEffect, useRef, useCallback } from "react";
import { useSetAtom } from "jotai";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  attachImage,
  getArtifact,
  removeAttachment,
  updateArtifact,
  updateDraft,
  convertArtifactKind,
  deleteArtifact,
  listDrafts,
} from "@/commands/artifact";
import type { Artifact, ArtifactDraft, ArtifactDraftKind, ArtifactKind } from "@/commands/artifact";
import { saveDraftAtom, deleteDraftAtom, closeLibraryTabAtom } from "@/features/library/store";

type WriterProps = { mode: "draft"; draftId: string } | { mode: "artifact"; artifactId: string };

type SaveStatus = "idle" | "saving" | "saved" | "error";
type SaveTarget = {
  mode: WriterProps["mode"];
  data: ArtifactDraft | Artifact;
  entityKey: string;
  revision: number;
};

export function Writer(props: WriterProps) {
  const [data, setData] = useState<ArtifactDraft | Artifact | null>(null);
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const saveDraft = useSetAtom(saveDraftAtom);
  const deleteDraft = useSetAtom(deleteDraftAtom);
  const closeTab = useSetAtom(closeLibraryTabAtom);
  const debounceRef = useRef<number>(0);
  const revisionRef = useRef(0);
  const dataRef = useRef(data);
  const bodyRef = useRef(body);
  const titleRef = useRef(title);
  dataRef.current = data;
  bodyRef.current = body;
  titleRef.current = title;

  const entityId = props.mode === "draft" ? props.draftId : props.artifactId;
  const entityKey = `${props.mode}:${entityId}`;
  const entityKeyRef = useRef(entityKey);
  entityKeyRef.current = entityKey;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setData(null);
      setBody("");
      setTitle("");
      setSaveStatus("idle");

      if (props.mode === "draft") {
        const drafts = await listDrafts();
        const draft = drafts.find((d) => d.id === entityId);
        if (draft && !cancelled) {
          setData(draft);
          setBody(draft.body);
          setTitle(titleFromKind(draft.kind));
          revisionRef.current = draft.revision;
        }
      } else {
        const artifact = await getArtifact(entityId);
        if (artifact && !cancelled) {
          setData(artifact);
          setBody(artifact.body);
          setTitle(titleFromKind(artifact.kind));
          revisionRef.current = artifact.revision;
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [props.mode, entityId]);

  const persistTarget = useCallback(
    async (target: SaveTarget, newBody: string, newTitle: string) => {
      const isCurrentTarget = entityKeyRef.current === target.entityKey;
      const expectedRevision = isCurrentTarget ? revisionRef.current : target.revision;

      if (target.mode === "draft") {
        const kind = buildDraftKind(target.data.kind, newTitle);
        const updated = await updateDraft(target.data.id, kind, newBody, null, expectedRevision);
        if (isCurrentTarget) {
          revisionRef.current = updated.revision;
          setData(updated);
        }
        return;
      }

      const kind = buildArtifactKind(target.data.kind, newTitle);
      const updated = await updateArtifact(target.data.id, kind, newBody, null, expectedRevision);
      if (isCurrentTarget) {
        revisionRef.current = updated.revision;
        setData(updated);
      }
    },
    [],
  );

  const autoSave = useCallback(
    async (target: SaveTarget, newBody: string, newTitle: string) => {
      const isCurrentTarget = entityKeyRef.current === target.entityKey;
      if (isCurrentTarget) setSaveStatus("saving");
      try {
        await persistTarget(target, newBody, newTitle);
        if (isCurrentTarget) setSaveStatus("saved");
      } catch {
        if (isCurrentTarget) setSaveStatus("error");
      }
    },
    [persistTarget],
  );

  const clearPendingAutoSave = useCallback(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = 0;
  }, []);

  const flushCurrentEdit = useCallback(async () => {
    clearPendingAutoSave();
    const current = dataRef.current;
    if (!current) return false;

    const target: SaveTarget = {
      mode: props.mode,
      data: current,
      entityKey: entityKeyRef.current,
      revision: revisionRef.current,
    };

    setSaveStatus("saving");
    try {
      await persistTarget(target, bodyRef.current, titleRef.current);
      setSaveStatus("saved");
      return true;
    } catch {
      setSaveStatus("error");
      return false;
    }
  }, [clearPendingAutoSave, persistTarget, props.mode]);

  function scheduleAutoSave(newBody: string, newTitle: string) {
    if (!data) return;
    const target: SaveTarget = {
      mode: props.mode,
      data,
      entityKey,
      revision: revisionRef.current,
    };
    clearPendingAutoSave();
    debounceRef.current = window.setTimeout(() => void autoSave(target, newBody, newTitle), 800);
  }

  function handleBodyChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setBody(v);
    scheduleAutoSave(v, title);
  }

  function handleTitleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setTitle(v);
    scheduleAutoSave(body, v);
  }

  const handleSave = useCallback(async () => {
    const current = dataRef.current;
    if (!current) return;
    const flushed = await flushCurrentEdit();
    if (!flushed) return;
    if (props.mode === "draft") {
      try {
        await saveDraft(current.id);
      } catch {
        setSaveStatus("error");
      }
    }
  }, [props.mode, saveDraft, flushCurrentEdit]);

  async function handleDelete() {
    if (!data) return;
    clearPendingAutoSave();
    if (props.mode === "draft") {
      await deleteDraft(data.id);
    } else {
      await deleteArtifact(data.id);
    }
    closeTab();
  }

  async function handleConvertKind(targetType: "memo" | "essay" | "intent") {
    if (!data || props.mode === "draft") return;
    const flushed = await flushCurrentEdit();
    if (!flushed) return;
    const existingProjectId = data.kind.type === "intent" ? (data.kind.project_id ?? null) : null;
    let target: ArtifactKind;
    switch (targetType) {
      case "memo":
        target = { type: "memo" };
        break;
      case "essay":
        target = { type: "essay", title: title.trim() || "Untitled" };
        break;
      case "intent":
        target = {
          type: "intent",
          title: title.trim() || "Untitled",
          project_id: existingProjectId,
        };
        break;
    }
    const converted = await convertArtifactKind(data.id, target, revisionRef.current);
    revisionRef.current = converted.revision;
    setData(converted);
    setTitle(titleFromKind(converted.kind));
  }

  const handleDroppedFiles = useCallback(async (paths: string[]) => {
    const current = dataRef.current;
    if (!current || paths.length === 0) return;
    const targetId = current.id;
    setSaveStatus("saving");
    try {
      const attachments = await Promise.all(paths.map((path) => attachImage(targetId, path)));
      setData((prev) =>
        prev?.id === targetId
          ? { ...prev, attachments: [...prev.attachments, ...attachments] }
          : prev,
      );
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }, []);

  async function handleRemoveAttachment(id: string) {
    setSaveStatus("saving");
    try {
      await removeAttachment(id);
      setData((current) =>
        current
          ? { ...current, attachments: current.attachments.filter((a) => a.id !== id) }
          : current,
      );
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          void handleDroppedFiles(event.payload.paths);
        }
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleDroppedFiles]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-[12px] text-muted-foreground/40">Loading…</span>
      </div>
    );
  }

  const kindType = data.kind.type;
  const showTitle = kindType === "essay" || kindType === "intent";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-6 py-2">
        <span className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
          {kindType}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground/30">
          {saveStatus === "saving"
            ? "Saving…"
            : saveStatus === "saved"
              ? "Saved"
              : saveStatus === "error"
                ? "Save failed"
                : ""}
        </span>
        {props.mode === "draft" && (
          <button
            onClick={handleSave}
            className="rounded-md bg-white/[0.08] px-3 py-1 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-white/[0.12]"
          >
            Save
          </button>
        )}
        {props.mode === "artifact" && kindType !== "memo" && (
          <button
            onClick={() => handleConvertKind("memo")}
            className="rounded-md px-2 py-1 text-[10px] text-muted-foreground/40 transition-colors hover:bg-white/[0.06] hover:text-muted-foreground"
          >
            → memo
          </button>
        )}
        {props.mode === "artifact" && kindType !== "essay" && (
          <button
            onClick={() => handleConvertKind("essay")}
            className="rounded-md px-2 py-1 text-[10px] text-muted-foreground/40 transition-colors hover:bg-white/[0.06] hover:text-muted-foreground"
          >
            → essay
          </button>
        )}
        <button
          onClick={handleDelete}
          className="rounded-md px-2 py-1 text-[10px] text-muted-foreground/30 transition-colors hover:text-destructive"
        >
          Delete
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-2 scrollbar-hide">
        <div className="mx-auto max-w-2xl">
          {showTitle && (
            <input
              type="text"
              value={title}
              onChange={handleTitleChange}
              placeholder={kindType === "essay" ? "Essay title…" : "Intent title…"}
              className="mb-4 w-full border-none bg-transparent text-[20px] font-medium text-foreground placeholder:text-muted-foreground/20 focus:outline-none"
            />
          )}
          <textarea
            value={body}
            onChange={handleBodyChange}
            placeholder="Write something…"
            className="min-h-[60vh] w-full resize-none border-none bg-transparent text-[14px] leading-relaxed text-foreground/90 placeholder:text-muted-foreground/20 focus:outline-none"
          />
          {data.attachments.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {data.attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="flex max-w-full items-center gap-2 rounded-md bg-white/[0.06] px-2 py-1"
                >
                  <span className="truncate text-[11px] text-muted-foreground/70">
                    {attachment.original_file_name}
                  </span>
                  <button
                    onClick={() => handleRemoveAttachment(attachment.id)}
                    aria-label={`Remove ${attachment.original_file_name}`}
                    className="text-[12px] text-muted-foreground/40 transition-colors hover:text-destructive"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function buildDraftKind(
  existing: ArtifactDraftKind | ArtifactKind,
  title: string,
): ArtifactDraftKind {
  const existingProjectId = existing.type === "intent" ? (existing.project_id ?? null) : null;
  switch (existing.type) {
    case "essay":
      return { type: "essay", title: title || null };
    case "intent":
      return { type: "intent", title: title || null, project_id: existingProjectId };
    default:
      return { type: "memo" };
  }
}

function titleFromKind(kind: ArtifactDraftKind | ArtifactKind): string {
  return kind.type === "memo" ? "" : (kind.title ?? "");
}

function buildArtifactKind(
  existing: ArtifactDraftKind | ArtifactKind,
  title: string,
): ArtifactKind {
  const existingProjectId = existing.type === "intent" ? (existing.project_id ?? null) : null;
  switch (existing.type) {
    case "essay":
      return { type: "essay", title: title.trim() || "" };
    case "intent":
      return { type: "intent", title: title.trim() || "", project_id: existingProjectId };
    default:
      return { type: "memo" };
  }
}
