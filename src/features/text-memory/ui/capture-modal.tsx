import { useEffect, useRef, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  captureDraftTypeAtom,
  captureOpenAtom,
  bumpTextRefreshAtom,
  openCaptureAtom,
} from "@/features/text-memory/store";
import {
  createTextArtifact,
  intentSeedStatusOptions,
  textArtifactTypeOptions,
  type ArtifactType,
  type ArtifactTypeOption,
  type IntentSeedStatusOption,
} from "@/commands/text";
import { PlusIcon, XIcon } from "@/components/icons";
import { pushErrorToast, pushInfoToast } from "@/stores/toast";
import { cn } from "@/lib/utils";

export function GlobalCaptureButton() {
  const openCapture = useSetAtom(openCaptureAtom);

  return (
    <button
      type="button"
      onClick={() => openCapture()}
      className="ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title="Capture (Cmd+Shift+N)"
    >
      <PlusIcon size={13} />
      Capture
    </button>
  );
}

export function CaptureModal() {
  const [open, setOpen] = useAtom(captureOpenAtom);
  const [artifactType, setArtifactType] = useAtom(captureDraftTypeAtom);
  const bumpRefresh = useSetAtom(bumpTextRefreshAtom);
  const [typeOptions, setTypeOptions] = useState<ArtifactTypeOption[]>([]);
  const [statusOptions, setStatusOptions] = useState<IntentSeedStatusOption[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("seed");
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    Promise.all([textArtifactTypeOptions(), intentSeedStatusOptions()])
      .then(([types, statuses]) => {
        setTypeOptions(types);
        setStatusOptions(statuses);
      })
      .catch((e) => pushErrorToast(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setStatus("seed");
    requestAnimationFrame(() => bodyRef.current?.focus());
  }, [open]);

  if (!open) return null;

  const canSave = title.trim().length > 0 || body.trim().length > 0;

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const artifact = await createTextArtifact({
        artifact_type: artifactType,
        title: title.trim() || null,
        body,
        status: artifactType === "intent_seed" ? status : null,
        source_artifact_id: null,
      });
      bumpRefresh();
      pushInfoToast(`Captured ${artifact.id}`);
      setOpen(false);
    } catch (e) {
      pushErrorToast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/35 px-4 pt-[12vh]">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <select
            value={artifactType}
            onChange={(e) => setArtifactType(e.target.value as ArtifactType)}
            className="h-7 rounded-md border border-border bg-background px-2 text-[12px] outline-none focus:border-muted-foreground/50"
          >
            {typeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {artifactType === "intent_seed" && (
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-7 rounded-md border border-border bg-background px-2 text-[12px] outline-none focus:border-muted-foreground/50"
            >
              {statusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground">Cmd+Enter saves</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Close"
          >
            <XIcon size={14} />
          </button>
        </div>
        <div className="flex flex-col gap-2 p-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Optional title"
            className="h-9 rounded-md border border-border bg-background px-3 text-[13px] outline-none placeholder:text-muted-foreground/45 focus:border-muted-foreground/50"
          />
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.metaKey && e.key === "Enter") {
                e.preventDefault();
                void save();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              }
            }}
            placeholder="Write before classifying."
            className="min-h-44 resize-none rounded-md border border-border bg-background p-3 text-[13px] leading-6 outline-none placeholder:text-muted-foreground/45 focus:border-muted-foreground/50"
            data-testid="capture-body"
          />
          <div className="flex items-center justify-between">
            <span
              className={cn(
                "text-[11px]",
                saving ? "text-muted-foreground" : "text-muted-foreground/70",
              )}
            >
              {saving ? "Saving..." : "No title or folder required"}
            </span>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!canSave || saving}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[12px] text-primary-foreground transition-opacity disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
