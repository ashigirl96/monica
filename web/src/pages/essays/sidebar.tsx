import { spaLinkClick } from "@/app";
import type { NoteSummary } from "@/types.gen";
import { essayTitle } from "./support";

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
          const title = essayTitle(s) || s.preview || "Untitled";
          return (
            <div
              key={s.id}
              className={`group relative flex items-center rounded-md transition-colors duration-100 ${
                selected ? "bg-[var(--ink-hover)]" : "hover:bg-[var(--ink-hover)]"
              }`}
            >
              {selected && (
                <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-[var(--ink-muted)]" />
              )}
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                className="min-w-0 flex-1 px-2.5 py-1.5 text-left"
              >
                <span
                  className={`block truncate text-[0.8rem] ${
                    selected ? "text-[var(--ink-text)]" : "text-[var(--ink-muted)]"
                  }`}
                >
                  {title}
                </span>
              </button>
            </div>
          );
        })}
        {essays !== null && essays.length === 0 && (
          <p className="px-2.5 py-2 text-[0.75rem] text-[var(--ink-faint)]">No writing essays</p>
        )}
      </div>
    </div>
  );
}
