import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export type FuzzyPickerItem = { key: string; label: string };

export type FuzzyPickerModalProps = {
  items: FuzzyPickerItem[];
  onSelect: (key: string | null) => void;
  onClose: () => void;
  placeholder?: string;
  footer?: string;
};

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

export function useFuzzyPicker({
  items,
  onSelect,
  onClose,
}: {
  items: FuzzyPickerItem[];
  onSelect: (key: string | null) => void;
  onClose: () => void;
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

  function onKeyDown(e: KeyboardEvent) {
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
    }
  }

  return { query, setQuery, highlightIndex, filtered, listRef, inputRef, onKeyDown };
}
