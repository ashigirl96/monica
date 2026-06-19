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
import type { TimelineItem } from "@/commands/artifact";
import { MemoComposer } from "./memo-composer";
import { convertFileSrc } from "@tauri-apps/api/core";

export function TimelineView() {
  const items = useAtomValue(timelineItemsAtom);
  const hasMore = useAtomValue(timelineHasMoreAtom);
  const loading = useAtomValue(timelineLoadingAtom);
  const loadTimeline = useSetAtom(loadTimelineAtom);
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
        if (entries[0].isIntersecting) loadTimeline();
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadTimeline]);

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
        <div className="mx-auto flex max-w-2xl flex-col gap-1">
          <MemoComposer />

          {items.length === 0 && !loading && (
            <div className="flex flex-col items-center gap-3 pt-20">
              <span className="text-[13px] text-muted-foreground/60">No activity yet</span>
              <button
                onClick={() => loadTimeline()}
                className="text-[12px] text-muted-foreground/40 underline decoration-dotted underline-offset-4 transition-colors hover:text-muted-foreground"
              >
                Show older activity
              </button>
            </div>
          )}

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
  if (item.kind === "artifact") {
    switch (item.artifact_kind) {
      case "memo":
        return <MemoRow item={item} onClick={onClick} />;
      case "essay":
        return <EssayRow item={item} onClick={onClick} />;
      case "intent":
        return <IntentRow item={item} onClick={onClick} />;
      default:
        return <ArtifactFallbackRow item={item} onClick={onClick} />;
    }
  }

  return <TaskRow item={item} onClick={onClick} />;
}

type ArtifactItem = Extract<TimelineItem, { kind: "artifact" }>;

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("ja-JP", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MemoRow({ item, onClick }: { item: ArtifactItem; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full flex-col gap-1.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-medium tracking-wider text-muted-foreground/50 uppercase">
          memo
        </span>
        <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground/30">
          {formatTime(item.timeline_at)}
        </span>
      </div>
      {item.body_preview && (
        <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground/70">
          {item.body_preview}
        </p>
      )}
      {item.thumbnail_paths.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {item.thumbnail_paths.map((path) => (
            <img
              key={path}
              src={convertFileSrc(path)}
              alt=""
              className="h-16 w-16 rounded object-cover"
            />
          ))}
        </div>
      )}
    </button>
  );
}

function EssayRow({ item, onClick }: { item: ArtifactItem; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-medium tracking-wider text-blue-400/60 uppercase">
          essay
        </span>
        {item.title && (
          <span className="truncate text-[13px] font-medium text-foreground/90">{item.title}</span>
        )}
        <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground/30">
          {formatTime(item.timeline_at)}
        </span>
      </div>
      {item.body_preview && (
        <p className="line-clamp-2 text-[12px] leading-relaxed text-muted-foreground/70">
          {item.body_preview}
        </p>
      )}
      <span className="text-[10px] text-muted-foreground/30">
        updated {formatTime(item.updated_at)}
      </span>
    </button>
  );
}

function IntentRow({ item, onClick }: { item: ArtifactItem; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-medium tracking-wider text-amber-400/60 uppercase">
          intent
        </span>
        {item.title && (
          <span className="truncate text-[13px] font-medium text-foreground/90">{item.title}</span>
        )}
        {item.project_name && (
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground/50">
            {item.project_name}
          </span>
        )}
        <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground/30">
          {formatTime(item.timeline_at)}
        </span>
      </div>
      {item.body_preview && (
        <p className="line-clamp-2 text-[12px] leading-relaxed text-muted-foreground/70">
          {item.body_preview}
        </p>
      )}
    </button>
  );
}

function ArtifactFallbackRow({ item, onClick }: { item: ArtifactItem; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-medium tracking-wider text-muted-foreground/50 uppercase">
          {item.artifact_kind}
        </span>
        {item.title && (
          <span className="truncate text-[13px] font-medium text-foreground/90">{item.title}</span>
        )}
        <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground/30">
          {formatTime(item.timeline_at)}
        </span>
      </div>
      {item.body_preview && (
        <p className="line-clamp-2 text-[12px] leading-relaxed text-muted-foreground/70">
          {item.body_preview}
        </p>
      )}
    </button>
  );
}

function TaskRow({
  item,
  onClick,
}: {
  item: Extract<TimelineItem, { kind: "task_created" | "task_closed" }>;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
    >
      <span className="text-[10px] tracking-wider text-muted-foreground/30 uppercase">
        {item.kind === "task_created" ? "created" : "closed"}
      </span>
      <span className="truncate text-[12px] text-muted-foreground/50">{item.title}</span>
      <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground/30">
        {formatTime(item.timeline_at)}
      </span>
    </button>
  );
}
