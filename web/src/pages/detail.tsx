import { useEffect, useState } from "react";
import { deleteExplanation, getExplanation } from "@/api";
import { navigate, spaLinkClick } from "@/app";
import { DeleteDialog } from "@/components/delete-dialog";
import { formatDate, formatRelative } from "@/format";
import type { Explanation } from "@/types.gen";

function ModeIndicator({ mode }: { mode: string }) {
  const dot = mode === "diff" ? "bg-accent-diff" : "bg-accent-topic";
  const text = mode === "diff" ? "text-accent-diff" : "text-accent-topic";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block size-1.5 rounded-full ${dot}`} />
      <span className={`font-mono text-[0.7rem] uppercase tracking-widest ${text}`}>{mode}</span>
    </span>
  );
}

export function DetailPage({ id }: { id: string }) {
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);

  useEffect(() => {
    getExplanation(id)
      .then(setExplanation)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Unknown error"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <div className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      </div>
    );
  }

  if (error || !explanation) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
          {error ?? "Explanation not found"}
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="border-b bg-background/85">
        <div className="mx-auto flex h-12 w-full max-w-[860px] items-center gap-3">
          <a
            href="/explanations"
            onClick={spaLinkClick("/explanations")}
            className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <img src="/favicon.png" alt="" className="size-5" />
            Library
          </a>
          <span className="text-xs text-muted-foreground/40">/</span>

          <h1 className="min-w-0 truncate text-base font-medium">{explanation.title}</h1>

          <div className="ml-auto flex shrink-0 items-center gap-3">
            <ModeIndicator mode={explanation.mode} />
            {explanation.repo_name && (
              <span className="hidden font-mono text-xs text-muted-foreground/70 sm:inline">
                {explanation.repo_name}
              </span>
            )}
            <time
              dateTime={explanation.created_at}
              className="hidden text-xs text-muted-foreground/70 sm:inline"
              title={formatDate(explanation.created_at)}
            >
              {formatRelative(explanation.created_at)}
            </time>
            <button
              type="button"
              aria-label="Delete"
              title="Delete"
              onClick={() => setShowDelete(true)}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <svg
                className="size-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
                />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <iframe
        src={`/explanations/${id}/artifact`}
        title={explanation.title}
        className="flex-1 border-0 bg-background"
        sandbox="allow-scripts"
      />

      {showDelete && (
        <DeleteDialog
          title={explanation.title}
          onDelete={() => deleteExplanation(id)}
          onClose={() => setShowDelete(false)}
          onDeleted={() => navigate("/explanations")}
        />
      )}
    </>
  );
}
