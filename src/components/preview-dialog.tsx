import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

type PreviewDialogProps = {
  label: string;
  title: string;
  titleTooltip?: string;
  closeLabel: string;
  onClose: () => void;
  bodyRef?: RefObject<HTMLDivElement | null>;
  onDialogKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  bodyClassName?: string;
  children: ReactNode;
};

// Quick Look-style overlay shared by plan preview and task memo. Portaled to
// document.body so a hidden/inert space wrapper can't reach it. Moving focus into the
// dialog keeps typed keys, paste and IME out of the xterm behind it; on close focus
// returns to whatever held it (normally the terminal).
export function PreviewDialog({
  label,
  title,
  titleTooltip,
  closeLabel,
  onClose,
  bodyRef,
  onDialogKeyDown,
  bodyClassName,
  children,
}: PreviewDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const restoreFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => restoreFocus?.focus?.();
  }, []);

  return createPortal(
    <div
      className="animate-in fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-[6vh] backdrop-blur-sm duration-150"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        className="animate-in zoom-in-95 flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none duration-150"
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <span className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-foreground/70">
            {label}
          </span>
          <span
            className="flex-1 truncate font-mono text-xs text-muted-foreground"
            title={titleTooltip}
          >
            {title}
          </span>
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            esc
          </kbd>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon size={14} />
          </button>
        </header>
        {/* lift notebook-md's 980px reading cap so the content tracks the dialog width */}
        <div
          ref={bodyRef}
          className={cn("overflow-y-auto px-6 py-5 [&_.notebook-md]:max-w-none", bodyClassName)}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function PreviewDialogLoading() {
  return <div className="py-2 text-xs text-muted-foreground/40">Loading…</div>;
}
