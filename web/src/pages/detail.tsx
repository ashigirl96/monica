import { useEffect, useState } from "react";
import { formatDate, getExplanation } from "@/api";
import { navigate } from "@/app";
import { DeleteDialog } from "@/components/delete-dialog";
import type { Explanation } from "@/types.gen";

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
    return <div className="text-sm text-muted-foreground">Loading&hellip;</div>;
  }

  if (error || !explanation) {
    return <div className="text-sm text-destructive">{error ?? "Explanation not found"}</div>;
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => navigate("/explanations")}
            className="mb-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            &larr; All explanations
          </button>
          <h1 className="text-lg font-medium tracking-tight">{explanation.title}</h1>
          <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono tracking-wide">
              {explanation.mode}
            </span>
            <span className="font-mono">{explanation.id}</span>
            <span>{formatDate(explanation.created_at)}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowDelete(true)}
          className="shrink-0 rounded-md border border-destructive/30 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground"
        >
          Delete
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <iframe
          src={`/explanations/${id}/artifact`}
          title={explanation.title}
          className="h-[calc(100vh-220px)] w-full border-0 bg-white"
          sandbox="allow-scripts"
        />
      </div>

      {showDelete && (
        <DeleteDialog
          title={explanation.title}
          id={id}
          onClose={() => setShowDelete(false)}
          onDeleted={() => navigate("/explanations")}
        />
      )}
    </div>
  );
}
