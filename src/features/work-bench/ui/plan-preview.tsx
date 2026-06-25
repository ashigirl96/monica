import { lazy, Suspense } from "react";
import { useAtom, useAtomValue } from "jotai";
import { createPortal } from "react-dom";
import { XIcon } from "@/components/icons";
import { activeSpaceAtom } from "@/stores/space";
import { planPreviewAtom } from "@/features/work-bench/store";

// Lazy so react-markdown / shiki / mermaid / katex stay out of the Workbench startup bundle and
// load only when a plan is first previewed.
const MarkdownView = lazy(() => import("@/components/markdown/markdown-view"));

export function PlanPreview() {
  const [plan, setPlan] = useAtom(planPreviewAtom);
  const activeSpace = useAtomValue(activeSpaceAtom);
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
        role="dialog"
        aria-modal
        onClick={(e) => e.stopPropagation()}
        className="animate-in zoom-in-95 flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl duration-150"
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
        <div className="overflow-y-auto px-6 py-5">
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
