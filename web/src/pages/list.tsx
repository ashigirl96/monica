import { useEffect, useState } from "react";
import { formatDate, listExplanations } from "@/api";
import { navigate } from "@/app";
import type { Explanation } from "@/types.gen";

function ModeBadge({ mode }: { mode: string }) {
  return (
    <span className="inline-block rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] tracking-wide text-muted-foreground">
      {mode}
    </span>
  );
}

export function ListPage() {
  const [explanations, setExplanations] = useState<Explanation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listExplanations()
      .then(setExplanations)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Unknown error"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading&hellip;</div>;
  }

  if (error) {
    return <div className="text-sm text-destructive">{error}</div>;
  }

  return (
    <div>
      <h1 className="mb-8 text-lg font-medium tracking-tight">Explanations</h1>
      {explanations.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No explanations yet. Create one with{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">monica explain new</code>
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {explanations.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => navigate(`/explanations/${e.id}`)}
                className="group flex w-full items-center gap-3 px-1 py-3 text-left transition-colors hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium group-hover:text-foreground">
                    {e.title}
                  </span>
                  <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                    {formatDate(e.created_at)}
                  </span>
                </div>
                <ModeBadge mode={e.mode} />
                <svg
                  className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
