import { useAtomValue, useSetAtom } from "jotai";
import { Fragment } from "react";
import type { TaskSummaryRow } from "@/commands/task";
import { cn } from "@/lib/utils";
import { PopoverMenu } from "@/components/popover-menu";
import { type OpenTarget, openTargets } from "@/features/work-board/github-urls";
import { IssueIcon, PrIcon } from "@/features/work-board/ui/github-icons";
import { taskSummariesAtom } from "@/stores/workboard";
import {
  AGENT_TARGETS,
  MENU_ITEMS,
  executeMenuItemAtom,
  executeRunAtom,
  isItemDisabled,
  menuAtom,
  navigateSubmenuAtom,
  setMenuItemIndexAtom,
  type MenuState,
} from "@/features/work-board/nav";

export function BoardContextMenu() {
  const menu = useAtomValue(menuAtom);
  if (menu === null) return null;
  return <MenuPopover menu={menu} />;
}

function MenuPopover({ menu }: { menu: MenuState }) {
  const setMenu = useSetAtom(menuAtom);
  const task = useAtomValue(taskSummariesAtom).find((t) => t.id === menu.taskId);

  if (!task) return null;

  return (
    <PopoverMenu anchor={menu.anchor} onClose={() => setMenu(null)}>
      {menu.submenu?.kind === "run" ? (
        <RunSubmenu runIndex={menu.submenu.index} />
      ) : menu.submenu?.kind === "open" ? (
        <OpenSubmenu openIndex={menu.submenu.index} targets={openTargets(task)} />
      ) : (
        <ItemList menu={menu} task={task} />
      )}
    </PopoverMenu>
  );
}

function ItemList({ menu, task }: { menu: MenuState; task: TaskSummaryRow }) {
  const setItemIndex = useSetAtom(setMenuItemIndexAtom);
  const executeItem = useSetAtom(executeMenuItemAtom);

  return (
    <>
      {MENU_ITEMS.map((item, i) => {
        const disabled = isItemDisabled(item.id, task);
        const selected = i === menu.itemIndex;
        const isClose = item.id === "close";
        return (
          <Fragment key={item.id}>
            {isClose && <div className="my-1 h-px bg-border" />}
            <button
              type="button"
              disabled={disabled}
              onMouseEnter={() => setItemIndex(i)}
              onClick={() => executeItem()}
              className={cn(
                "flex w-full items-center justify-between rounded px-2 py-1 text-left text-[12px]",
                isClose ? "text-destructive" : "text-popover-foreground",
                selected && (isClose ? "bg-destructive/15" : "bg-accent text-accent-foreground"),
                disabled && "opacity-40",
              )}
            >
              <span>{isClose && menu.confirmingClose ? "Enter to confirm" : item.label}</span>
              {item.hint && (
                <span className="font-mono text-[10px] text-muted-foreground">{item.hint}</span>
              )}
            </button>
          </Fragment>
        );
      })}
    </>
  );
}

function OpenSubmenu({ openIndex, targets }: { openIndex: number; targets: OpenTarget[] }) {
  const navigate = useSetAtom(navigateSubmenuAtom);
  const executeItem = useSetAtom(executeMenuItemAtom);

  return (
    <>
      <button
        type="button"
        onClick={() => navigate({ type: "exit" })}
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
        const selected = i === openIndex;
        return (
          <button
            key={target.id}
            type="button"
            onMouseEnter={() => navigate({ type: "setIndex", index: i })}
            onClick={() => {
              navigate({ type: "setIndex", index: i });
              executeItem();
            }}
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

function RunSubmenu({ runIndex }: { runIndex: number }) {
  const navigate = useSetAtom(navigateSubmenuAtom);
  const executeRun = useSetAtom(executeRunAtom);

  return (
    <>
      <button
        type="button"
        onClick={() => navigate({ type: "exit" })}
        className="group flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex items-center gap-1">
          <span aria-hidden className="transition-transform group-hover:-translate-x-0.5">
            ‹
          </span>
          <span className="font-medium tracking-wide uppercase">Run</span>
        </span>
        <span className="font-mono text-[10px] opacity-60">esc</span>
      </button>
      <div className="my-1 h-px bg-border" />
      {AGENT_TARGETS.map((target, i) => {
        const selected = i === runIndex;
        return (
          <button
            key={target.agent}
            type="button"
            onMouseEnter={() => navigate({ type: "setIndex", index: i })}
            onClick={() => {
              navigate({ type: "setIndex", index: i });
              executeRun();
            }}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[12px] text-popover-foreground",
              selected && "bg-accent text-accent-foreground",
            )}
          >
            <span>{target.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{target.hint}</span>
          </button>
        );
      })}
    </>
  );
}

// Mirrors the task card's PR badge palette; the open/draft test reuses the Rust-computed flag.
function prStatusDot(target: Extract<OpenTarget, { kind: "pr" }>): string {
  if (target.isOpenOrDraft) return "bg-emerald-400";
  if (target.status === "merged") return "bg-purple-400";
  return "bg-muted-foreground/50";
}
