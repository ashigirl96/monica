const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable='true'], [contenteditable='']";

export function isEditable(e: KeyboardEvent): boolean {
  const el = e.target;
  return el instanceof HTMLElement && el.closest(EDITABLE_SELECTOR) !== null;
}
