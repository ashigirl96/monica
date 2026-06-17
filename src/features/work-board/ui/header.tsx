import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { trackIssueMutationAtom } from "@/stores/workboard";
import { prSyncLastSyncedAtom } from "@/stores/pr-sync";
import { cn } from "@/lib/utils";

function TrackIssueButton() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { mutateAsync: trackIssue, isPending } = useAtomValue(trackIssueMutationAtom);

  const handleSubmit = useCallback(async () => {
    setError(null);
    try {
      await trackIssue(value);
      setValue("");
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to track issue");
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
            if (e.key === "Enter" && !isPending) handleSubmit();
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
        disabled={isPending || !value.trim()}
        className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-[11px] text-primary-foreground transition-opacity disabled:opacity-40"
      >
        {isPending ? "..." : "Track"}
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

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function LastSyncedLabel() {
  const lastSyncAt = useAtomValue(prSyncLastSyncedAtom);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (lastSyncAt === null) return;
    const timer = setInterval(() => forceUpdate((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [lastSyncAt]);

  if (lastSyncAt === null) return null;

  const elapsed = Math.floor((Date.now() - lastSyncAt) / 1000);
  return (
    <span className="ml-auto text-[10px] text-muted-foreground/60">
      Synced {formatElapsed(elapsed)}
    </span>
  );
}

export function WorkBoardHeader() {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5">
      <TrackIssueButton />
      <LastSyncedLabel />
    </div>
  );
}
