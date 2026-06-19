import { useState, useEffect, useRef, useCallback } from "react";
import { useSetAtom } from "jotai";
import {
  getArtifact,
  updateArtifact,
  updateDraft,
  convertArtifactKind,
  deleteArtifact,
  deleteDraft,
  listDrafts,
} from "@/commands/artifact";
import type { Artifact, ArtifactDraft, ArtifactDraftKind, ArtifactKind } from "@/commands/artifact";
import { saveDraftAtom, closeLibraryTabAtom } from "@/features/library/store";

type WriterProps = { mode: "draft"; draftId: string } | { mode: "artifact"; artifactId: string };

type SaveStatus = "idle" | "saving" | "saved" | "error";

export function Writer(props: WriterProps) {
  const [data, setData] = useState<ArtifactDraft | Artifact | null>(null);
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const saveDraft = useSetAtom(saveDraftAtom);
  const closeTab = useSetAtom(closeLibraryTabAtom);
  const debounceRef = useRef<number>(0);
  const revisionRef = useRef(0);
  const bodyRef = useRef(body);
  const titleRef = useRef(title);
  bodyRef.current = body;
  titleRef.current = title;

  const entityId = props.mode === "draft" ? props.draftId : props.artifactId;

  useEffect(() => {
    async function load() {
      if (props.mode === "draft") {
        const drafts = await listDrafts();
        const draft = drafts.find((d) => d.id === entityId);
        if (draft) {
          setData(draft);
          setBody(draft.body);
          revisionRef.current = draft.revision;
          if (draft.kind.type !== "memo" && draft.kind.title) {
            setTitle(draft.kind.title);
          }
        }
      } else {
        const artifact = await getArtifact(entityId);
        if (artifact) {
          setData(artifact);
          setBody(artifact.body);
          revisionRef.current = artifact.revision;
          if (artifact.kind.type !== "memo" && artifact.kind.title) {
            setTitle(artifact.kind.title);
          }
        }
      }
    }
    load();
  }, [props.mode, entityId]);

  const autoSave = useCallback(
    async (newBody: string, newTitle: string) => {
      if (!data) return;
      setSaveStatus("saving");
      try {
        if (props.mode === "draft") {
          const kind = buildDraftKind(data.kind, newTitle);
          const updated = await updateDraft(data.id, kind, newBody, null, revisionRef.current);
          revisionRef.current = updated.revision;
        } else {
          const kind = buildArtifactKind(data.kind, newTitle);
          const updated = await updateArtifact(data.id, kind, newBody, null, revisionRef.current);
          revisionRef.current = updated.revision;
        }
        setSaveStatus("saved");
      } catch {
        setSaveStatus("error");
      }
    },
    [data, props.mode],
  );

  function scheduleAutoSave(newBody: string, newTitle: string) {
    clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => autoSave(newBody, newTitle), 800);
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
    if (!data) return;
    clearTimeout(debounceRef.current);
    if (props.mode === "draft") {
      await saveDraft(data.id);
    } else {
      await autoSave(bodyRef.current, titleRef.current);
    }
  }, [data, props.mode, saveDraft, autoSave]);

  async function handleDelete() {
    if (!data) return;
    if (props.mode === "draft") {
      await deleteDraft(data.id);
    } else {
      await deleteArtifact(data.id);
    }
    closeTab();
  }

  async function handleConvertKind(targetType: "memo" | "essay" | "intent") {
    if (!data || props.mode === "draft") return;
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
    if (converted.kind.type === "memo") setTitle("");
  }

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
