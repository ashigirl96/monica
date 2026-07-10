import { lazy, Suspense, useEffect, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";
import { PreviewDialog, PreviewDialogLoading } from "@/components/preview-dialog";
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
  const open = plan !== null && activeSpace === "work-bench";

  // The capture listener only adds j/k scrolling — Esc-close and the app's modifier shortcuts
  // (Cmd+E, Cmd+1–3, zoom) stay with the global handler, and every other key is left alone so
  // the dialog stays keyboard-navigable.
  useEffect(() => {
    if (!open) return;
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
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Gate on the active space so the overlay can't linger over another space after a
  // Cmd+1/Cmd+3 switch.
  if (!plan || activeSpace !== "work-bench") return null;

  return (
    <PreviewDialog
      label="Plan"
      title={plan.file_name}
      titleTooltip={plan.path}
      closeLabel="Close plan preview"
      onClose={() => setPlan(null)}
      bodyRef={scrollRef}
    >
      <Suspense fallback={<PreviewDialogLoading />}>
        <MarkdownView body={plan.body} />
      </Suspense>
    </PreviewDialog>
  );
}
