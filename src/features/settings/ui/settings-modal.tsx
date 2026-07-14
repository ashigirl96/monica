import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAtom } from "jotai";
import { PlusIcon, XIcon } from "@/components/icons";
import {
  DEFAULT_TRANSLATE_PORT,
  onOpenSettingsRequested,
  translateSettingsGet,
  translateSettingsSave,
  type TranslateSettings,
  type TranslateSettingsSnapshot,
} from "@/commands/settings";
import { settingsModalOpenAtom } from "@/features/settings/store";
import { cn } from "@/lib/utils";

// Record は全キー必須 + 余剰キー拒否なので、Rust 側 enum の追加・削除・改名が
// どの方向でも TS のコンパイルエラーとして現れる（bindings の union が単一の正）
const MODEL_OPTIONS = Object.keys({
  haiku: null,
  sonnet: null,
  opus: null,
} satisfies Record<TranslateSettings["model"], null>) as TranslateSettings["model"][];
const EFFORT_OPTIONS = Object.keys({
  low: null,
  medium: null,
  high: null,
} satisfies Record<TranslateSettings["effort"], null>) as TranslateSettings["effort"][];

export function SettingsModal() {
  const [open, setOpen] = useAtom(settingsModalOpenAtom);

  useEffect(() => {
    const unlisten = onOpenSettingsRequested(() => setOpen(true));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [setOpen]);

  if (!open) return null;
  return <SettingsDialog onClose={() => setOpen(false)} />;
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<TranslateSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<TranslateSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    translateSettingsGet()
      .then((snap) => {
        if (cancelled) return;
        setSnapshot(snap);
        setDraft(snap.settings);
      })
      .catch((e: { message?: string }) => {
        if (!cancelled) setError(e.message ?? String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(() => {
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    translateSettingsSave({
      ...draft,
      allowed_origins: draft.allowed_origins.map((o) => o.trim()).filter((o) => o.length > 0),
    })
      .then((snap) => {
        setSnapshot(snap);
        setDraft(snap.settings);
      })
      .catch((e: { message?: string }) => setError(e.message ?? String(e)))
      .finally(() => setSaving(false));
  }, [draft, saving]);

  const patch = (partial: Partial<TranslateSettings>) =>
    setDraft((d) => (d ? { ...d, ...partial } : d));

  return createPortal(
    <div
      className="animate-in fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm duration-150"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
          e.stopPropagation();
          onClose();
        }}
        className="animate-in zoom-in-95 flex max-h-[80vh] w-[28rem] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none duration-150"
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <span className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-foreground/70">
            Settings
          </span>
          <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
            Browser translation
          </span>
          {snapshot && <BridgeStatus running={snapshot.bridge_running} />}
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            esc
          </kbd>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon size={14} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {draft === null && error === null && (
            <div className="py-2 text-xs text-muted-foreground/40">Loading…</div>
          )}

          {draft && (
            <div className="flex flex-col gap-4">
              <SettingRow label="Enabled" hint="Runs the translate server while Monica is open">
                <Toggle checked={draft.enabled} onChange={(enabled) => patch({ enabled })} />
              </SettingRow>

              <SettingRow label="Model">
                <select
                  value={draft.model}
                  onChange={(e) => patch({ model: e.target.value as TranslateSettings["model"] })}
                  className="h-7 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-muted-foreground/40"
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </SettingRow>

              <SettingRow label="Effort">
                <select
                  value={draft.effort}
                  onChange={(e) => patch({ effort: e.target.value as TranslateSettings["effort"] })}
                  className="h-7 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-muted-foreground/40"
                >
                  {EFFORT_OPTIONS.map((e2) => (
                    <option key={e2} value={e2}>
                      {e2}
                    </option>
                  ))}
                </select>
              </SettingRow>

              <SettingRow
                label="Port"
                hint={
                  draft.port === DEFAULT_TRANSLATE_PORT
                    ? undefined
                    : `Ports other than ${DEFAULT_TRANSLATE_PORT} require rebuilding the extension`
                }
              >
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port}
                  onChange={(e) => patch({ port: Number(e.target.value) })}
                  className="h-7 w-24 rounded-md border border-border bg-background px-2 text-right font-mono text-xs text-foreground outline-none focus:border-muted-foreground/40"
                />
              </SettingRow>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-foreground/80">Allowed origins</span>
                <div className="flex flex-col gap-1">
                  {draft.allowed_origins.map((origin, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={origin}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) =>
                          patch({
                            allowed_origins: draft.allowed_origins.map((o, j) =>
                              j === i ? e.target.value : o,
                            ),
                          })
                        }
                        className="h-7 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-muted-foreground/40"
                      />
                      <button
                        type="button"
                        aria-label="Remove origin"
                        onClick={() =>
                          patch({
                            allowed_origins: draft.allowed_origins.filter((_, j) => j !== i),
                          })
                        }
                        className="text-muted-foreground/60 transition-colors hover:text-foreground"
                      >
                        <XIcon size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => patch({ allowed_origins: [...draft.allowed_origins, ""] })}
                  className="flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                >
                  <PlusIcon size={12} />
                  Add origin
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="mt-3 rounded-md bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!draft || saving}
            className={cn(
              "rounded-md bg-foreground/10 px-3 py-1 text-xs font-medium text-foreground transition-colors",
              !draft || saving ? "opacity-50" : "hover:bg-foreground/15",
            )}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function BridgeStatus({ running }: { running: boolean }) {
  return (
    <span
      title={running ? "Translate server is running" : "Translate server is not running"}
      className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          running ? "bg-emerald-400" : "bg-muted-foreground/40",
        )}
      />
      {running ? "running" : "stopped"}
    </span>
  );
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5 pt-1">
        <span className="text-xs text-foreground/80">{label}</span>
        {hint && <span className="text-[10px] leading-4 text-muted-foreground/60">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 rounded-full transition-colors",
        checked ? "bg-emerald-500/80" : "bg-foreground/15",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}
