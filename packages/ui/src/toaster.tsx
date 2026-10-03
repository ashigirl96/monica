import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { cn } from "./cn.ts";
import { XIcon } from "./icons.tsx";
import { dismissToast, pushErrorToast, type Toast, toastsAtom } from "./toast.ts";

const TONE: Record<Toast["type"], { border: string; dot: string }> = {
  error: { border: "border-destructive/40", dot: "bg-destructive" },
  info: { border: "border-border", dot: "bg-muted-foreground/60" },
};

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

export function Toaster() {
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      pushErrorToast(errorMessage(e.reason));
    };
    const onError = (e: ErrorEvent) => {
      pushErrorToast(e.message);
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);

  const toasts = useAtomValue(toastsAtom);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-3 bottom-3 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "animate-in fade-in slide-in-from-bottom-2 pointer-events-auto flex items-start gap-2 rounded-lg border bg-card px-3 py-2.5 shadow-lg",
            TONE[t.type].border,
          )}
        >
          <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", TONE[t.type].dot)} />
          <p className="min-w-0 flex-1 text-[12px] leading-snug break-words text-foreground select-text">
            {t.message}
          </p>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
