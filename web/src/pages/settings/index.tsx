import { useEffect, useState } from "react";
import { getNotesSettings, putNotesSettings } from "@/api";
import "../notes/notes.css";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourLabel(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

/**
 * 1日の境界を 24h 軸上の線として描く。境界より前のセル（前日に帰属する時間帯）は
 * インクで淡く塗られ、境界の左端に縦バーが立つ — 「境界」という設定値の意味を
 * そのまま可視化する。クリック / フォーカス + Enter で選択、選択即保存。
 */
function BoundaryStrip({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (hour: number) => void;
}) {
  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Day boundary hour"
        className="flex overflow-hidden rounded-md border border-[var(--ink-border)]"
      >
        {HOURS.map((h) => {
          const previousDay = h < value;
          const boundary = h === value;
          return (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={boundary}
              aria-label={`Set boundary to ${hourLabel(h)}`}
              title={hourLabel(h)}
              disabled={disabled}
              onClick={() => onChange(h)}
              className={`relative h-9 flex-1 transition-colors duration-100 focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-[var(--ink-muted)] ${
                previousDay ? "bg-[color-mix(in_srgb,var(--ink)_12%,transparent)]" : ""
              } ${disabled ? "" : "hover:bg-[var(--ink-hover)]"}`}
            >
              {boundary && (
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 w-0.5 bg-[var(--ink-text)]"
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-1 grid grid-cols-4 font-mono text-[0.6rem] text-[var(--ink-faint)]">
        {[0, 6, 12, 18].map((h) => (
          <span key={h}>{hourLabel(h)}</span>
        ))}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [hour, setHour] = useState<number | null>(null);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");

  useEffect(() => {
    let cancelled = false;
    getNotesSettings()
      .then((s) => {
        if (!cancelled) setHour(s.day_boundary_hour);
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = (next: number) => {
    const previous = hour;
    setHour(next);
    putNotesSettings({ day_boundary_hour: next })
      .then((s) => {
        setHour(s.day_boundary_hour);
        setStatus("saved");
      })
      .catch(() => {
        setHour(previous);
        setStatus("error");
      });
  };

  return (
    <div className="notes-screen h-dvh flex-1 overflow-y-auto bg-[var(--paper)]">
      <div className="mx-auto w-full max-w-[640px] px-10 pb-24">
        <header className="pt-12">
          <p className="font-mono text-[0.65rem] uppercase tracking-widest text-[var(--ink-faint)]">
            Settings
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-[var(--ink-text)]">Notes</h1>
        </header>

        <section className="mt-10 border-t border-[var(--ink-border)] pt-6">
          <div className="flex items-baseline justify-between">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-widest text-[var(--ink-faint)]">
              Day boundary
            </h2>
            {status === "saved" && (
              <span className="font-mono text-[0.65rem] uppercase tracking-widest text-[var(--ink-faint)]">
                Saved
              </span>
            )}
            {status === "error" && (
              <span className="text-xs text-destructive">Failed to save — try again</span>
            )}
          </div>
          <p className="mt-2 max-w-[46ch] text-sm text-[var(--ink-muted)]">
            Hours before the boundary belong to the previous day. Set it past midnight if you write
            late — a note at 3 AM files under yesterday.
          </p>

          <div className="mt-5">
            {hour === null ? (
              <div className="h-9 animate-pulse rounded-md bg-[var(--ink-hover)]" />
            ) : (
              <BoundaryStrip value={hour} disabled={false} onChange={save} />
            )}
          </div>

          {hour !== null && (
            <p className="mt-3 font-mono text-[0.7rem] text-[var(--ink-muted)]">
              {hour === 0
                ? "00:00 — days change at midnight"
                : `${hourLabel(hour)} — notes before ${hourLabel(hour)} file under the previous day`}
            </p>
          )}

          <p className="mt-4 text-xs text-[var(--ink-faint)]">
            Applies to new notes only; existing notes keep their dates.
          </p>
        </section>
      </div>
    </div>
  );
}
