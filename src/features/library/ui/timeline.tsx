import { useEffect, useRef, useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  timelineItemsAtom,
  timelineHasMoreAtom,
  timelineLoadingAtom,
  loadTimelineAtom,
  openArtifactTabAtom,
} from "@/features/library/store";
import { activeSpaceAtom } from "@/stores/space";
import { cn } from "@/lib/utils";
import type { TimelineItem } from "@/commands/artifact";

export function TimelineView() {
  const items = useAtomValue(timelineItemsAtom);
  const hasMore = useAtomValue(timelineHasMoreAtom);
  const loading = useAtomValue(timelineLoadingAtom);
  const loadTimeline = useSetAtom(loadTimelineAtom);
  const loadOlder = useSetAtom(loadTimelineAtom);
  const openArtifact = useSetAtom(openArtifactTabAtom);
  const setActiveSpace = useSetAtom(activeSpaceAtom);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadTimeline(true);
  }, [loadTimeline]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadOlder();
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadOlder]);

  const handleItemClick = useCallback(
    (item: TimelineItem) => {
      if (item.kind === "artifact") {
        openArtifact(item.entry_id);
      } else {
        setActiveSpace("work-board");
      }
    },
    [openArtifact, setActiveSpace],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-3 scrollbar-hide">
        {items.length === 0 && !loading && (
          <div className="flex flex-col items-center gap-3 pt-20">
            <span className="text-[13px] text-muted-foreground/60">No activity yet</span>
            <button
              onClick={() => loadOlder()}
              className="text-[12px] text-muted-foreground/40 underline decoration-dotted underline-offset-4 transition-colors hover:text-muted-foreground"
            >
              Show older activity
            </button>
          </div>
        )}

        <div className="mx-auto flex max-w-2xl flex-col gap-1">
          {items.map((item) => (
            <TimelineRow key={item.item_key} item={item} onClick={() => handleItemClick(item)} />
          ))}
        </div>

        {hasMore && <div ref={sentinelRef} className="h-8" />}

        {loading && (
          <div className="flex justify-center py-4">
            <span className="text-[11px] text-muted-foreground/40">Loading…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineRow({ item, onClick }: { item: TimelineItem; onClick: () => void }) {
  const time = new Date(item.timeline_at).toLocaleString("ja-JP", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  if (item.kind === "artifact") {
    return (
      <button
        onClick={onClick}
        className="group flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
      >
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-[10px] font-medium tracking-wider uppercase",
              item.artifact_kind === "memo"
                ? "text-muted-foreground/50"
                : item.artifact_kind === "essay"
                  ? "text-blue-400/60"
                  : "text-amber-400/60",
            )}
          >
            {item.artifact_kind}
          </span>
          {item.title && (
            <span className="truncate text-[13px] font-medium text-foreground/90">
              {item.title}
            </span>
          )}
          <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground/30">{time}</span>
        </div>
        {item.body_preview && (
          <p className="line-clamp-2 text-[12px] leading-relaxed text-muted-foreground/70">
            {item.body_preview}
          </p>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
    >
      <span className="text-[10px] tracking-wider text-muted-foreground/30 uppercase">
        {item.kind === "task_created" ? "created" : "closed"}
      </span>
      <span className="truncate text-[12px] text-muted-foreground/50">{item.title}</span>
      <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground/30">{time}</span>
    </button>
  );
}
