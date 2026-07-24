import { useEffect, useState } from "react";
import { createEssay, listEssays } from "@/api";
import { navigate, spaLinkClick } from "@/app";
import type { NoteSummary } from "@/types.gen";
import { essayStatus, essayTitle, slashDate } from "./support";
import "../notes/notes.css";

/** 机に原稿を並べて見渡す。タイル = デスクマット、その中央に紙のミニチュア */
function EssayCard({ summary }: { summary: NoteSummary }) {
  const writing = essayStatus(summary) === "writing";
  const title = essayTitle(summary);
  return (
    <a
      href={`/essays/${summary.id}`}
      onClick={spaLinkClick(`/essays/${summary.id}`)}
      className="group block focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--ink-muted)]"
    >
      <div
        className={`relative aspect-[4/3] rounded-2xl transition-[transform,box-shadow] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-[0_6px_18px_-8px_color-mix(in_srgb,var(--ink)_35%,transparent)] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 ${
          writing
            ? "bg-[color-mix(in_srgb,var(--kind-essay)_8%,var(--paper))]"
            : "bg-[color-mix(in_srgb,var(--ink)_5%,var(--paper))]"
        }`}
      >
        {writing && (
          <span className="absolute top-3 left-3 rounded-full bg-[color-mix(in_srgb,var(--kind-essay)_16%,var(--paper))] px-2 py-0.5 font-mono text-[0.55rem] uppercase tracking-widest text-[var(--ink-muted)]">
            writing
          </span>
        )}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-[68%] w-auto min-w-0 overflow-hidden rounded-[3px] border border-[var(--ink-border)] bg-[var(--paper)] px-2.5 py-2 shadow-[0_1px_4px_color-mix(in_srgb,var(--ink)_18%,transparent)] aspect-[3/4]">
            <p className="truncate text-[7px] leading-tight font-medium text-[var(--ink-text)]">
              {title || "Untitled"}
            </p>
            {summary.preview && (
              <p className="mt-1 line-clamp-6 text-[6px] leading-[1.7] break-all text-[var(--ink-faint)]">
                {summary.preview}
              </p>
            )}
          </div>
        </div>
      </div>
      <h2 className="mt-3 line-clamp-2 text-[0.95rem] leading-snug text-[var(--ink-text)]">
        {title || "Untitled"}
      </h2>
      <p className="mt-1 font-mono text-[0.7rem] text-[var(--ink-faint)]">
        {slashDate(summary.updated_at)}
      </p>
    </a>
  );
}

export function EssaysListPage() {
  const [essays, setEssays] = useState<NoteSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listEssays()
      .then((list) => {
        if (cancelled) return;
        setEssays(list);
        setListError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setListError(e instanceof Error ? e.message : "Failed to load essays");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // capture phase で登録する: エディタは無い画面だが、他画面と流儀を揃える
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.code !== "KeyN") return;
      e.preventDefault();
      e.stopPropagation();
      void createEssay()
        .then((created) => navigate(`/essays/${created.id}`))
        .catch(() => {
          // 作成失敗は次の ⌥N で再試行できるので黙って握る
        });
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="notes-screen h-dvh overflow-y-auto bg-[var(--paper)]">
      <div className="mx-auto w-full max-w-[1080px] px-10 pt-10 pb-24">
        <h1 className="font-mono text-[0.8rem] uppercase tracking-widest text-[var(--ink-muted)]">
          Essays
        </h1>
        {listError ? (
          <p className="mt-10 text-sm text-destructive">{listError}</p>
        ) : essays !== null && essays.length === 0 ? (
          <p className="mt-10 text-sm text-[var(--ink-faint)]">
            No essays yet — press ⌥N to start writing
          </p>
        ) : (
          <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-7 gap-y-10">
            {(essays ?? []).map((s) => (
              <EssayCard key={s.id} summary={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
