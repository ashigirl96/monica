import { IssueIcon, PrIcon } from "@/components/github-icons";
import type { OpenTarget } from "@/lib/github-targets";
import { cn } from "@/lib/utils";

// Mirrors the task card's PR badge palette; the open/draft test reuses the Rust-computed flag.
function prStatusDot(target: Extract<OpenTarget, { kind: "pr" }>): string {
  if (target.isOpenOrDraft) return "bg-emerald-400";
  if (target.status === "merged") return "bg-purple-400";
  return "bg-muted-foreground/50";
}

export function OpenTargetList({
  targets,
  selectedIndex,
  onHover,
  onSelect,
  onBack,
}: {
  targets: OpenTarget[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  onBack: () => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="group flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex items-center gap-1">
          <span aria-hidden className="transition-transform group-hover:-translate-x-0.5">
            ‹
          </span>
          <span className="font-medium tracking-wide uppercase">Open</span>
        </span>
        <span className="font-mono text-[10px] opacity-60">esc</span>
      </button>
      <div className="my-1 h-px bg-border" />
      {targets.map((target, i) => {
        const selected = i === selectedIndex;
        return (
          <button
            key={target.id}
            type="button"
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(i)}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[12px] text-popover-foreground",
              selected && "bg-accent text-accent-foreground",
            )}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn("shrink-0", selected ? "opacity-100" : "opacity-60")}>
                {target.kind === "issue" ? <IssueIcon /> : <PrIcon />}
              </span>
              <span>{target.kind === "issue" ? "Issue" : "Pull Request"}</span>
              <span
                className={cn(
                  "font-mono text-[10px]",
                  selected ? "text-accent-foreground/70" : "text-muted-foreground",
                )}
              >
                #{target.number}
              </span>
            </span>
            {target.kind === "issue" ? (
              <span
                className={cn(
                  "font-mono text-[10px]",
                  selected ? "text-accent-foreground/70" : "text-muted-foreground",
                )}
              >
                i
              </span>
            ) : (
              <span className={cn("size-1.5 shrink-0 rounded-full", prStatusDot(target))} />
            )}
          </button>
        );
      })}
    </>
  );
}
