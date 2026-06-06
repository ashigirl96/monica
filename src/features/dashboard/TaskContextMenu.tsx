import { cn } from "@/lib/utils";
import { ExternalLink, GitPullRequest, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TaskView } from "./types";

interface MenuItem {
  label: string;
  icon: React.ReactNode;
  disabled: boolean;
  destructive?: boolean;
  onSelect: () => void;
}

interface TaskContextMenuProps {
  item: TaskView;
  onClose: () => void;
  onOpenIssue: () => void;
  onOpenPR: () => void;
  onDelete: () => void;
}

export function TaskContextMenu({
  item,
  onClose,
  onOpenIssue,
  onOpenPR,
  onDelete,
}: TaskContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hasIssue = item.project !== null && item.githubIssueNumber !== null;
  const hasPR = (item.githubPullRequests[0]?.url ?? null) !== null;
  const [activeIndex, setActiveIndex] = useState(() => (hasIssue ? 0 : hasPR ? 1 : 2));
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const items: MenuItem[] = [
    {
      label: "Open Issue",
      icon: <ExternalLink className="size-4" />,
      disabled: !hasIssue,
      onSelect: onOpenIssue,
    },
    {
      label: "Open Pull Request",
      icon: <GitPullRequest className="size-4" />,
      disabled: !hasPR,
      onSelect: onOpenPR,
    },
    {
      label: "Delete",
      icon: <Trash2 className="size-4" />,
      disabled: false,
      destructive: true,
      onSelect: onDelete,
    },
  ];

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuRef.current?.focus();
    return () => {
      prev?.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    const anchor = document.querySelector<HTMLElement>(`[data-task-id="${item.id}"]`);
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const flipUp = anchorRect.bottom + menuRect.height + 8 > window.innerHeight;
    setPosition({
      top: flipUp ? anchorRect.top - menuRect.height - 4 : anchorRect.bottom + 4,
      left: anchorRect.left,
    });
  }, [item.id]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  const navigateIndex = (direction: 1 | -1) => {
    let next = activeIndex;
    for (let i = 0; i < items.length; i++) {
      next = (next + direction + items.length) % items.length;
      if (!items[next]?.disabled) break;
    }
    setActiveIndex(next);
  };

  const selectCurrent = () => {
    const current = items[activeIndex];
    if (current && !current.disabled) {
      current.onSelect();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        navigateIndex(1);
        break;
      case "ArrowUp":
        navigateIndex(-1);
        break;
      case "Enter":
      case " ":
        selectCurrent();
        break;
      case "Tab":
      case "Escape":
        onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="タスクのアクション"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed z-50 min-w-[200px] rounded-lg border border-border/70 bg-card py-1 shadow-2xl outline-none"
      style={{
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        animation: "menu-in 0.12s ease-out",
      }}
    >
      {items.map((menuItem, index) => (
        <div
          key={menuItem.label}
          role="menuitem"
          aria-disabled={menuItem.disabled || undefined}
          onClick={() => {
            if (!menuItem.disabled) menuItem.onSelect();
          }}
          onMouseEnter={() => {
            if (!menuItem.disabled) setActiveIndex(index);
          }}
          className={cn(
            "flex w-full cursor-default items-center gap-2.5 px-4 py-2.5 text-[13px] transition-colors",
            menuItem.destructive ? "text-destructive" : "text-foreground",
            menuItem.disabled && "opacity-40",
            !menuItem.disabled && index === activeIndex && "bg-foreground/[0.06]",
          )}
        >
          {menuItem.icon}
          {menuItem.label}
        </div>
      ))}
    </div>
  );
}
