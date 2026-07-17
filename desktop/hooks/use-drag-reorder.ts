import { useEffect, useRef, useState } from "react";

const DRAG_THRESHOLD_SQ = 25;

export function useDragReorder(reorder: (from: string, to: string) => void) {
  const dragIdRef = useRef<string | null>(null);
  const isDraggingRef = useRef(false);
  const startPosRef = useRef({ x: 0, y: 0 });
  const dragOverIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => {
    const finalize = () => {
      if (!dragIdRef.current) return;
      if (
        isDraggingRef.current &&
        dragOverIdRef.current &&
        dragOverIdRef.current !== dragIdRef.current
      ) {
        reorder(dragIdRef.current, dragOverIdRef.current);
      }
      dragIdRef.current = null;
      isDraggingRef.current = false;
      dragOverIdRef.current = null;
      setDragOverId(null);
    };

    const onMove = (e: PointerEvent) => {
      if (!dragIdRef.current) return;
      if (e.buttons === 0) {
        finalize();
        return;
      }
      if (isDraggingRef.current) return;
      const dx = e.clientX - startPosRef.current.x;
      const dy = e.clientY - startPosRef.current.y;
      if (dx * dx + dy * dy > DRAG_THRESHOLD_SQ) {
        isDraggingRef.current = true;
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", finalize);
    document.addEventListener("pointercancel", finalize);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", finalize);
      document.removeEventListener("pointercancel", finalize);
    };
  }, [reorder]);

  const handlersFor = (id: string, onActivate?: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragIdRef.current = id;
      startPosRef.current = { x: e.clientX, y: e.clientY };
      isDraggingRef.current = false;
      onActivate?.();
    },
    onPointerEnter: () => {
      if (isDraggingRef.current && dragIdRef.current && dragIdRef.current !== id) {
        dragOverIdRef.current = id;
        setDragOverId(id);
      }
    },
    onPointerLeave: () => {
      if (dragOverIdRef.current === id) {
        dragOverIdRef.current = null;
        setDragOverId(null);
      }
    },
  });

  return { dragOverId, handlersFor };
}
