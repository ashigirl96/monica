import { lazy, Suspense, useEffect, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";
import { createPortal } from "react-dom";
import { XIcon } from "@/components/icons";
import { activeSpaceAtom } from "@/stores/space";
import { planPreviewAtom } from "@/features/work-bench/store";
import { SCROLL_STEP } from "@/features/library/store";

// Lazy so react-markdown / shiki / mermaid / katex stay out of the Workbench startup bundle and
// load only when a plan is first previewed.
const MarkdownView = lazy(() => import("@/components/markdown/markdown-view"));

export function PlanPreview() {
  const [plan, setPlan] = useAtom(planPreviewAtom);
  const activeSpace = useAtomValue(activeSpaceAtom);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const open = plan !== null && activeSpace === "work-bench";

  // Moving focus into the dialog is what keeps typed keys, paste and IME out of the xterm behind
  // it; on close we hand focus back to whatever held it (normally the terminal). The capture
  // listener only adds j/k scrolling — Esc-close and the app's modifier shortcuts (Cmd+E, Cmd+1–3,
  // zoom) stay with the global handler, and every other key is left alone so the dialog stays
  // keyboard-navigable.
  useEffect(() => {
    if (!open) return;
    const restoreFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "j") {
        e.preventDefault();
        scrollRef.current?.scrollBy({ top: SCROLL_STEP });
      } else if (key === "k") {
        e.preventDefault();
        scrollRef.current?.scrollBy({ top: -SCROLL_STEP });
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      restoreFocus?.focus?.();
    };
  }, [open]);

  // Portaled to document.body, so the bench wrapper's hide (opacity/inert) doesn't reach it —
  // gate on the active space so it can't linger over another space after a Cmd+1/Cmd+3 switch.
  if (!plan || activeSpace !== "work-bench") return null;
  const close = () => setPlan(null);

  return createPortal(
    <div
      className="animate-in fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-[6vh] backdrop-blur-sm duration-150"
      onClick={close}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="animate-in zoom-in-95 flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none duration-150"
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <span className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-foreground/70">
            Plan
          </span>
          <span
            className="flex-1 truncate font-mono text-xs text-muted-foreground"
            title={plan.path}
          >
            {plan.file_name}
          </span>
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            esc
          </kbd>
          <button
            type="button"
            onClick={close}
            aria-label="Close plan preview"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon size={14} />
          </button>
        </header>
        <div ref={scrollRef} className="overflow-y-auto px-6 py-5">
          <Suspense
            fallback={<div className="py-2 text-xs text-muted-foreground/40">Loading…</div>}
          >
            <MarkdownView body={plan.body} />
          </Suspense>
        </div>
      </div>
    </div>,
    document.body,
  );
}
