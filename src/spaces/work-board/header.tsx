import { useCallback, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { projectsAtom, selectedProjectAtom, trackIssueAtom } from "@/stores/workboard";
import { pushErrorToast } from "@/stores/toast";
import { cn } from "@/lib/utils";

function parseIssueInput(raw: string): { repo: string; number: number } | null {
  const trimmed = raw.trim();

  const urlMatch = trimmed.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  if (urlMatch) {
    return { repo: urlMatch[1], number: Number(urlMatch[2]) };
  }

  const refMatch = trimmed.match(/^([^#]+)#(\d+)$/);
  if (refMatch) {
    return { repo: refMatch[1].trim(), number: Number(refMatch[2]) };
  }

  return null;
}

function TrackIssueButton() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const trackIssue = useSetAtom(trackIssueAtom);

  const handleSubmit = useCallback(async () => {
    const parsed = parseIssueInput(value);
    if (!parsed) {
      setError("owner/repo#123 or GitHub issue URL");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await trackIssue(parsed);
      setValue("");
      setOpen(false);
    } catch (e) {
      pushErrorToast(e instanceof Error ? e.message : "Failed to track issue");
    } finally {
      setLoading(false);
    }
  }, [value, trackIssue]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <svg
          className="size-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Track Issue
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !loading) handleSubmit();
            if (e.key === "Escape") {
              setOpen(false);
              setValue("");
              setError(null);
            }
          }}
          placeholder="owner/repo#123 or issue URL"
          className={cn(
            "h-7 w-64 rounded-md border bg-background px-2.5 text-[12px] text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors",
            error ? "border-red-400/60" : "border-border focus:border-muted-foreground/40",
          )}
        />
        {error && <p className="absolute top-full left-0 mt-1 text-[10px] text-red-400">{error}</p>}
      </div>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={loading || !value.trim()}
        className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-[11px] text-primary-foreground transition-opacity disabled:opacity-40"
      >
        {loading ? "..." : "Track"}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setValue("");
          setError(null);
        }}
        className="inline-flex h-7 items-center rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <svg
          className="size-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

function ProjectFilter() {
  const projects = useAtomValue(projectsAtom);
  const [selected, setSelected] = useAtom(selectedProjectAtom);

  if (projects.length === 0) return null;

  return (
    <select
      value={selected ?? ""}
      onChange={(e) => setSelected(e.target.value || null)}
      className="h-7 rounded-md border border-border bg-secondary px-2 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground"
    >
      <option value="">All projects</option>
      {projects.map((p) => (
        <option key={p.repo} value={p.repo}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

export function WorkBoardHeader() {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5">
      <TrackIssueButton />
      <ProjectFilter />
    </div>
  );
}
