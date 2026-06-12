import { useRef, useState } from "react";

export function useDragReorder(reorder: (from: string, to: string) => void) {
  const dragIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const handlersFor = (id: string) => ({
    draggable: true,
    onDragStart: () => {
      dragIdRef.current = id;
    },
    onDragEnd: () => {
      dragIdRef.current = null;
      setDragOverId(null);
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOverId(id);
    },
    onDragLeave: () => setDragOverId(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOverId(null);
      if (dragIdRef.current && dragIdRef.current !== id) {
        reorder(dragIdRef.current, id);
      }
      dragIdRef.current = null;
    },
  });

  return { dragOverId, handlersFor };
}
