import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  bumpTextRefreshAtom,
  openCaptureAtom,
  textRefreshTokenAtom,
  textViewModeAtom,
  type TextViewMode,
} from "@/features/text-memory/store";
import {
  createTextArtifact,
  exportPersonalSpace,
  getTextArtifact,
  intentSeedStatusOptions,
  listTextArtifacts,
  promoteTextRecordToIntentSeed,
  textArtifactTypeOptions,
  updateTextArtifact,
  type Artifact,
  type ArtifactSummary,
  type ArtifactType,
  type ArtifactTypeOption,
  type IntentSeedStatusOption,
} from "@/commands/text";
import { ArrowUpRightIcon, DownloadIcon, PlusIcon, SearchIcon } from "@/components/icons";
import { pushErrorToast, pushInfoToast } from "@/stores/toast";
import { cn } from "@/lib/utils";

const VIEW_TO_TYPE: Record<TextViewMode, ArtifactType | null> = {
  all: null,
  record: "record",
  intent_seed: "intent_seed",
};

function TextMemoryContent() {
  const [viewMode, setViewMode] = useAtom(textViewModeAtom);
  const refreshToken = useAtomValue(textRefreshTokenAtom);
  const bumpRefresh = useSetAtom(bumpTextRefreshAtom);
  const openCapture = useSetAtom(openCaptureAtom);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ArtifactSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [loading, setLoading] = useState(false);
  const [typeOptions, setTypeOptions] = useState<ArtifactTypeOption[]>([]);
  const [statusOptions, setStatusOptions] = useState<IntentSeedStatusOption[]>([]);

  const artifactType = VIEW_TO_TYPE[viewMode];

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const next = await listTextArtifacts(artifactType, query.trim() || null);
      setItems(next);
      setSelectedId((current) => {
        if (current && next.some((item) => item.id === current)) return current;
        return next[0]?.id ?? null;
      });
    } catch (e) {
      pushErrorToast(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [artifactType, query]);

  useEffect(() => {
    Promise.all([textArtifactTypeOptions(), intentSeedStatusOptions()])
      .then(([types, statuses]) => {
        setTypeOptions(types);
        setStatusOptions(statuses);
      })
      .catch((e) => pushErrorToast(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList, refreshToken]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      setArtifact(null);
      return;
    }
    getTextArtifact(selectedId)
      .then((next) => {
        if (!cancelled) setArtifact(next);
      })
      .catch((e) => pushErrorToast(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function createDraft(type: ArtifactType) {
    try {
      const next = await createTextArtifact({
        artifact_type: type,
        title: null,
        body: "",
        status: type === "intent_seed" ? "seed" : null,
        source_artifact_id: null,
      });
      if (type === "intent_seed") setViewMode("intent_seed");
      if (type === "record") setViewMode("record");
      setSelectedId(next.id);
      setArtifact(next);
      bumpRefresh();
    } catch (e) {
      pushErrorToast(e instanceof Error ? e.message : String(e));
    }
  }

  async function promoteSelectedRecord(recordId: string) {
    try {
      const seed = await promoteTextRecordToIntentSeed(recordId);
      setViewMode("intent_seed");
      setSelectedId(seed.id);
      setArtifact(seed);
      bumpRefresh();
      pushInfoToast(`Created ${seed.id} from ${recordId}`);
    } catch (e) {
      pushErrorToast(e instanceof Error ? e.message : String(e));
    }
  }

  async function exportSpace() {
    try {
      const result = await exportPersonalSpace();
      pushInfoToast(`Exported ${result.artifact_count} artifacts to ${result.path}`);
    } catch (e) {
      pushErrorToast(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <SegmentedView value={viewMode} onChange={setViewMode} />
        <div className="relative ml-2 min-w-48 flex-1">
          <SearchIcon
            size={13}
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title or body"
            className="h-7 w-full rounded-md border border-border bg-background pr-2 pl-7 text-[12px] outline-none placeholder:text-muted-foreground/45 focus:border-muted-foreground/50"
            data-testid="text-search"
          />
        </div>
        <button
          type="button"
          onClick={() => void createDraft("record")}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-secondary px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PlusIcon size={12} />
          Record
        </button>
        <button
          type="button"
          onClick={() => void createDraft("intent_seed")}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-secondary px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PlusIcon size={12} />
          Intent
        </button>
        <button
          type="button"
          onClick={() => openCapture()}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] text-primary-foreground"
        >
          <PlusIcon size={12} />
          Capture
        </button>
        <button
          type="button"
          onClick={() => void exportSpace()}
          className="inline-flex size-7 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Export Personal Space"
          data-testid="text-export"
        >
          <DownloadIcon size={13} />
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,0.38fr)_minmax(420px,1fr)]">
        <div className="min-h-0 border-r border-border bg-background/35">
          <ArtifactStream
            items={items}
            selectedId={selectedId}
            loading={loading}
            onSelect={setSelectedId}
          />
        </div>
        <ArtifactEditor
          artifact={artifact}
          typeOptions={typeOptions}
          statusOptions={statusOptions}
          onSaved={(next) => {
            setArtifact(next);
            bumpRefresh();
          }}
          onPromote={promoteSelectedRecord}
          onOpenSource={(id) => {
            setViewMode("all");
            setSelectedId(id);
          }}
        />
      </div>
    </div>
  );
}

function SegmentedView({
  value,
  onChange,
}: {
  value: TextViewMode;
  onChange: (value: TextViewMode) => void;
}) {
  const options: { value: TextViewMode; label: string }[] = [
    { value: "record", label: "Records" },
    { value: "intent_seed", label: "Intent Seeds" },
    { value: "all", label: "All" },
  ];
  return (
    <div className="flex rounded-md border border-border bg-background p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "h-6 rounded px-2 text-[11px] transition-colors",
            value === option.value
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ArtifactStream({
  items,
  selectedId,
  loading,
  onSelect,
}: {
  items: ArtifactSummary[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  const groups = useMemo(() => groupByDate(items), [items]);

  if (loading && items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        Loading
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-[12px] leading-5 text-muted-foreground">
        Capture a record.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-2 scrollbar-hide" data-testid="artifact-stream">
      {groups.map((group) => (
        <div key={group.date} className="mb-3">
          <div className="px-2 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {group.date}
          </div>
          <div className="flex flex-col gap-1.5">
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                className={cn(
                  "rounded-md border px-2.5 py-2 text-left transition-colors",
                  selectedId === item.id
                    ? "border-muted-foreground/35 bg-card"
                    : "border-transparent bg-card/45 hover:border-border hover:bg-card",
                )}
                data-testid={`artifact-${item.id}`}
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">
                    {typeLabel(item.artifact_type)}
                  </span>
                  {item.status && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground uppercase">
                      {item.status}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-muted-foreground/70">
                    {formatTime(item.updated_at)}
                  </span>
                </div>
                <div className="truncate text-[13px] text-foreground">{displayTitle(item)}</div>
                {item.preview && (
                  <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {item.preview}
                  </div>
                )}
                {item.source_artifact_id && (
                  <div className="mt-1 text-[10px] text-muted-foreground/70">
                    From {item.source_artifact_id}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ArtifactEditor({
  artifact,
  typeOptions,
  statusOptions,
  onSaved,
  onPromote,
  onOpenSource,
}: {
  artifact: Artifact | null;
  typeOptions: ArtifactTypeOption[];
  statusOptions: IntentSeedStatusOption[];
  onSaved: (artifact: Artifact) => void;
  onPromote: (recordId: string) => void;
  onOpenSource: (artifactId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [artifactType, setArtifactType] = useState<ArtifactType>("record");
  const [status, setStatus] = useState("seed");
  const [preview, setPreview] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const savedKeyRef = useRef("");
  const artifactRef = useRef<Artifact | null>(artifact);
  artifactRef.current = artifact;

  useEffect(() => {
    const nextArtifact = artifactRef.current;
    if (!nextArtifact) {
      setTitle("");
      setBody("");
      setArtifactType("record");
      setStatus("seed");
      setSaveState("saved");
      savedKeyRef.current = "";
      return;
    }
    setTitle(nextArtifact.title ?? "");
    setBody(nextArtifact.body);
    setArtifactType(nextArtifact.artifact_type);
    setStatus(nextArtifact.status ?? "seed");
    setPreview(false);
    const key = draftKey(
      nextArtifact.title ?? "",
      nextArtifact.body,
      nextArtifact.artifact_type,
      nextArtifact.status ?? "seed",
    );
    savedKeyRef.current = key;
    setSaveState("saved");
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [artifact?.id]);

  useEffect(() => {
    if (!artifact) return;
    const currentKey = draftKey(title, body, artifactType, status);
    if (currentKey === savedKeyRef.current) {
      setSaveState("saved");
      return;
    }
    setSaveState("dirty");
    const handle = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        const next = await updateTextArtifact({
          id: artifact.id,
          artifact_type: artifactType,
          title: title.trim() || null,
          body,
          status: artifactType === "intent_seed" ? status : null,
        });
        savedKeyRef.current = draftKey(
          next.title ?? "",
          next.body,
          next.artifact_type,
          next.status ?? "seed",
        );
        setSaveState("saved");
        onSaved(next);
      } catch (e) {
        setSaveState("error");
        pushErrorToast(e instanceof Error ? e.message : String(e));
      }
    }, 700);
    return () => window.clearTimeout(handle);
  }, [artifact, artifactType, body, onSaved, status, title]);

  if (!artifact) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        Select or capture a record.
      </div>
    );
  }

  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;
  const charCount = body.length;

  return (
    <div className="flex min-h-0 flex-col bg-background/20" data-testid="artifact-editor">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <select
          value={artifactType}
          onChange={(e) => {
            const nextType = e.target.value as ArtifactType;
            setArtifactType(nextType);
            if (nextType === "intent_seed" && !status) setStatus("seed");
          }}
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
        <button
          type="button"
          onClick={() => setPreview((v) => !v)}
          className="h-7 rounded-md border border-border bg-secondary px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {preview ? "Edit" : "Preview"}
        </button>
        {artifactType === "record" && (
          <button
            type="button"
            onClick={() => onPromote(artifact.id)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-secondary px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="promote-record"
          >
            <ArrowUpRightIcon size={12} />
            Intent Seed
          </button>
        )}
        {artifact.source_artifact_id && (
          <button
            type="button"
            onClick={() => onOpenSource(artifact.source_artifact_id!)}
            className="h-7 rounded-md border border-border bg-secondary px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="open-source-artifact"
          >
            Source {artifact.source_artifact_id}
          </button>
        )}
        <span
          className={cn(
            "ml-auto text-[10px]",
            saveState === "error" ? "text-red-400" : "text-muted-foreground/70",
          )}
          data-testid="save-state"
        >
          {saveState === "dirty" ? "Unsaved" : saveState === "saving" ? "Saving..." : saveState}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Optional title"
          className="h-9 shrink-0 rounded-md border border-transparent bg-transparent px-1 text-[20px] font-semibold outline-none placeholder:text-muted-foreground/35 focus:border-border focus:bg-background"
          data-testid="artifact-title"
        />
        {preview ? (
          <ReadingPreview body={body} />
        ) : (
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Start writing."
            className="min-h-0 flex-1 resize-none rounded-md border border-border bg-background p-3 font-mono text-[13px] leading-6 outline-none placeholder:text-muted-foreground/45 focus:border-muted-foreground/50"
            data-testid="artifact-body"
          />
        )}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-[10px] text-muted-foreground/70">
        <span>{artifact.id}</span>
        <span>{charCount} chars</span>
        <span>{wordCount} words</span>
        <span className="ml-auto">Updated {formatTime(artifact.updated_at)}</span>
      </div>
    </div>
  );
}

function ReadingPreview({ body }: { body: string }) {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-background p-4 text-[14px] leading-7 whitespace-pre-wrap"
      data-testid="reading-preview"
    >
      {body || <span className="text-muted-foreground/50">Empty</span>}
    </div>
  );
}

function draftKey(title: string, body: string, artifactType: ArtifactType, status: string) {
  return JSON.stringify({
    title: title.trim(),
    body,
    artifactType,
    status: artifactType === "intent_seed" ? status : "",
  });
}

function groupByDate(items: ArtifactSummary[]) {
  const groups: { date: string; items: ArtifactSummary[] }[] = [];
  for (const item of items) {
    const date = formatDate(item.updated_at);
    const last = groups[groups.length - 1];
    if (last?.date === date) {
      last.items.push(item);
    } else {
      groups.push({ date, items: [item] });
    }
  }
  return groups;
}

function displayTitle(item: ArtifactSummary) {
  if (item.title) return item.title;
  if (item.preview) return item.preview;
  return item.artifact_type === "intent_seed" ? "Untitled Intent Seed" : "Untitled Record";
}

function typeLabel(type: ArtifactType) {
  if (type === "intent_seed") return "Intent";
  return type[0].toUpperCase() + type.slice(1);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(11, 16);
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default TextMemoryContent;
