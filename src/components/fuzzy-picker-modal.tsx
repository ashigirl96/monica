import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export type FuzzyPickerItem = { key: string; label: string };

export function FuzzyPickerModal({
  items,
  onSelect,
  onClose,
  placeholder = "Filter...",
  footer = "↑↓ move · ⏎ select · esc/^c close",
}: {
  items: FuzzyPickerItem[];
  onSelect: (key: string | null) => void;
  onClose: () => void;
  placeholder?: string;
  footer?: string;
}) {
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const filtered = items.filter((item) => fuzzyMatch(item.label, query));

  useEffect(() => {
    setHighlightIndex(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${highlightIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || (e.ctrlKey && e.key === "c")) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }

    if (e.ctrlKey && e.key === "w") {
      e.preventDefault();
      e.stopPropagation();
      onSelect(null);
      onClose();
      return;
    }

    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      const selected = filtered[highlightIndex];
      if (!selected) return;
      onSelect(selected.key);
      onClose();
      return;
    }

    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      e.stopPropagation();
      setHighlightIndex((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
      return;
    }

    if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      e.stopPropagation();
      setHighlightIndex((i) => Math.max(i - 1, 0));
      return;
    }
  };

  return createPortal(
    <div
      className="animate-in fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 duration-150"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="animate-in fade-in zoom-in-95 flex w-[36rem] flex-col rounded-xl border border-border bg-popover shadow-xl duration-150"
      >
        <div className="px-5 pt-5 pb-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            className="h-12 w-full rounded-lg border border-border bg-background px-4 font-mono text-base text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-muted-foreground/40"
          />
        </div>

        <div ref={listRef} className="max-h-96 overflow-y-auto px-3 pb-2">
          {filtered.map((item, i) => (
            <button
              key={item.key}
              type="button"
              data-index={i}
              onClick={() => {
                onSelect(item.key);
                onClose();
              }}
              className={cn(
                "w-full rounded-lg px-4 py-2.5 text-left font-mono text-base transition-colors",
                i === highlightIndex
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="border-t border-border/60 px-5 py-3">
          <span className="text-sm text-muted-foreground/50">{footer}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function fuzzyMatch(label: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;

  let index = 0;
  const haystack = label.toLowerCase();
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}
