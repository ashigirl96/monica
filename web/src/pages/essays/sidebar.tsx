import { spaLinkClick } from "@/app";
import type { NoteSummary } from "@/types.gen";
import { summaryTitle } from "@/notes/summary";

/** writing の essay だけを並べる（finished は /essays 一覧から開く）。⌥K/J はこのリスト内を巡回 */
export function EssaysSidebar({
  essays,
  selectedId,
  onSelect,
}: {
  essays: NoteSummary[] | null;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4.5 pt-4 pb-1">
        <a
          href="/essays"
          onClick={spaLinkClick("/essays")}
          className="font-mono text-[0.7rem] uppercase tracking-widest text-[var(--ink-muted)] transition-colors duration-100 hover:text-[var(--ink-text)]"
        >
          Essays
        </a>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {(essays ?? []).map((s) => {
          const selected = s.id === selectedId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              className={`relative block w-full rounded-md px-2.5 py-1.5 text-left transition-colors duration-100 ${
                selected ? "bg-[var(--ink-hover)]" : "hover:bg-[var(--ink-hover)]"
              }`}
            >
              {selected && (
                <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-[var(--water)]" />
              )}
              <span
                className={`block truncate text-[0.8rem] ${
                  selected ? "text-[var(--ink-text)]" : "text-[var(--ink-muted)]"
                }`}
              >
                {summaryTitle(s)}
              </span>
            </button>
          );
        })}
        {essays !== null && essays.length === 0 && (
          <p className="px-2.5 py-2 text-[0.75rem] text-[var(--ink-faint)]">No writing essays</p>
        )}
      </div>
    </div>
  );
}
