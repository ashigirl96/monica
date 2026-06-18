import { useCallback, useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import {
  sidebarWidthAtom,
  sidebarResizingAtom,
  SPACE_NAV_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
} from "@/stores/space";
import { clamp } from "@/lib/clamp";
import { cn } from "@/lib/utils";

export function ResizeHandle() {
  const setSidebarWidth = useSetAtom(sidebarWidthAtom);
  const setResizing = useSetAtom(sidebarResizingAtom);
  const dragging = useRef(false);
  const rafRef = useRef(0);

  const cleanup = useCallback(() => {
    dragging.current = false;
    setResizing(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, [setResizing]);

  useEffect(() => {
    return () => {
      if (dragging.current) {
        cleanup();
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [cleanup]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      setResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      function onMouseMove(e: MouseEvent) {
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0;
            const width = Math.round(
              clamp(e.clientX - SPACE_NAV_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
            );
            setSidebarWidth(width);
          });
        }
      }

      function onMouseUp() {
        cleanup();
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      }

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [setSidebarWidth, setResizing, cleanup],
  );

  const onDoubleClick = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }, [setSidebarWidth]);

  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      className="group relative z-10 w-1 flex-shrink-0 cursor-col-resize"
    >
      <div
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-100",
          "bg-transparent group-hover:bg-white/15 group-active:bg-white/30",
        )}
      />
    </div>
  );
}
