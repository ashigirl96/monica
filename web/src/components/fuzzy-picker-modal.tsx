import { createPortal } from "react-dom";
import { type FuzzyPickerModalProps, useFuzzyPicker } from "@shared/fuzzy-picker/use-fuzzy-picker";

export function FuzzyPickerModal({
  items,
  onSelect,
  onClose,
  placeholder = "Filter...",
  footer = "↑↓ move · ⏎ select · esc/^c close",
}: FuzzyPickerModalProps) {
  const { query, setQuery, highlightIndex, filtered, listRef, inputRef, onKeyDown } =
    useFuzzyPicker({ items, onSelect, onClose });

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="flex w-[36rem] flex-col rounded-xl border bg-card shadow-xl"
      >
        <div className="px-5 pt-5 pb-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            className="h-12 w-full rounded-lg border bg-background px-4 font-mono text-base text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-muted-foreground/40"
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
              className={`w-full rounded-lg px-4 py-2.5 text-left font-mono text-base transition-colors ${
                i === highlightIndex
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
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
