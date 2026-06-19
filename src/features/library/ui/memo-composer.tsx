import { useState, useCallback, useRef } from "react";
import { useSetAtom } from "jotai";
import { quickSaveMemoAtom } from "@/features/library/store";

export function MemoComposer() {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const saveMemo = useSetAtom(quickSaveMemoAtom);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSave = body.trim().length > 0 && !saving;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await saveMemo(body);
      setBody("");
      textareaRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }, [body, canSave, saveMemo]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSave();
      }
    },
    [handleSave],
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Write a memo..."
        rows={3}
        className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-foreground/90 placeholder:text-muted-foreground/30 focus:outline-none"
      />
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={!canSave}
          className="rounded-md bg-white/[0.08] px-3 py-1 text-[11px] font-medium text-foreground/70 transition-colors hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-30"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
