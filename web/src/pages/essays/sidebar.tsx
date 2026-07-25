import { useEffect, useRef } from "react";
import { spaLinkClick } from "@/app";
import type { EssayStatus } from "@/types.gen";
import { summaryTitle } from "@/notes/summary";
import { ESSAY_TABS, type EssayGroups } from "./support";

function StatusTab({
  status,
  count,
  active,
  onSelect,
}: {
  status: EssayStatus;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title="Switch writing / finished (⌥H / ⌥L)"
      className={`-mb-px border-b pb-1 font-mono text-[0.7rem] tracking-wider transition-colors duration-100 ${
        active
          ? "border-[var(--water)] text-[var(--ink-text)]"
          : "border-transparent text-[var(--ink-faint)] hover:text-[var(--ink-muted)]"
      }`}
    >
      {status} <span className="tabular-nums">{count}</span>
    </button>
  );
}

/** essay サイドバー。writing / finished のタブで片方だけを並べ、⌥K/J は表示中タブ内を巡回する。
 * タブは ⌥H/⌥L と、開いている note の status 変化（⌃Q）で動く。 */
export function EssaysSidebar({
  groups,
  tab,
  onTabChange,
  selectedId,
  onSelect,
}: {
  groups: EssayGroups | null;
  tab: EssayStatus;
  onTabChange: (status: EssayStatus) => void;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const essays = groups?.[tab] ?? null;
  const selectedRef = useRef<HTMLButtonElement>(null);
  const selectedVisible = essays !== null && essays.some((s) => s.id === selectedId);

  useEffect(() => {
    // tab: ⌃Q でタブが移ったとき（selectedId は変わらない）。selectedVisible: 一覧の到着や
    // 反対タブからの復帰。title 編集の patch では 3 つとも変わらないので空振りしない
    if (selectedVisible) selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId, tab, selectedVisible]);

  return (
    <div className="flex h-full flex-col">
      <div className="px-4.5 pt-4">
        <a
          href="/essays"
          onClick={spaLinkClick("/essays")}
          className="font-mono text-[0.7rem] uppercase tracking-widest text-[var(--ink-muted)] transition-colors duration-100 hover:text-[var(--ink-text)]"
        >
          Essays
        </a>
        {groups !== null && (
          <div className="mt-2 flex items-end gap-3 border-b border-[var(--ink-border)]">
            {ESSAY_TABS.map((status) => (
              <StatusTab
                key={status}
                status={status}
                count={groups[status].length}
                active={status === tab}
                onSelect={() => onTabChange(status)}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {(essays ?? []).map((s) => {
          const selected = s.id === selectedId;
          return (
            <button
              key={s.id}
              ref={selected ? selectedRef : null}
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
          <p className="px-2.5 py-2 text-[0.75rem] text-[var(--ink-faint)]">No {tab} essays</p>
        )}
      </div>
    </div>
  );
}
