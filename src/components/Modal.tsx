import { cn } from "@/lib/utils";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
  "[contenteditable='']",
].join(",");

interface FocusTargetRef {
  current: HTMLElement | null;
}

interface ModalProps {
  titleId: string;
  children: ReactNode;
  className?: string;
  initialFocusRef?: FocusTargetRef;
  focusKey?: string | number | null;
}

export function Modal({ titleId, children, className, initialFocusRef, focusKey }: ModalProps) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = initialFocusRef?.current ?? firstFocusable(panelRef.current) ?? panelRef.current;
    target?.focus();

    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [focusKey, initialFocusRef]);

  const trapTab = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();

    const focusables = focusableElements(panelRef.current);
    if (focusables.length === 0) {
      panelRef.current?.focus();
      return;
    }

    const currentIndex = focusables.findIndex((element) => element === document.activeElement);
    const nextIndex = e.shiftKey
      ? currentIndex <= 0
        ? focusables.length - 1
        : currentIndex - 1
      : currentIndex === -1 || currentIndex === focusables.length - 1
        ? 0
        : currentIndex + 1;

    focusables[nextIndex].focus();
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-background/70 px-4 backdrop-blur-sm">
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapTab}
        className={cn(
          "w-full max-w-sm rounded-lg border border-border/70 bg-card shadow-2xl",
          className,
        )}
      >
        {children}
      </section>
    </div>
  );
}

function firstFocusable(root: HTMLElement | null): HTMLElement | null {
  return focusableElements(root)[0] ?? null;
}

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && !element.getAttribute("aria-hidden"),
  );
}
