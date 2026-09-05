import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { PopoverMenu } from "@/components/popover-menu";
import { OpenTargetList } from "@/components/open-target-list";
import {
  closeOpenTargetMenuAtom,
  executeOpenTargetAtom,
  moveOpenTargetAtom,
  openTargetIndexAtom,
  openTargetMenuAtom,
  openTargetMenuStaleAtom,
  openTargetsAtom,
  type OpenTargetMenuState,
  setOpenTargetIndexAtom,
} from "@/features/work-bench/open-targets";

export function OpenTargetMenu() {
  const menu = useAtomValue(openTargetMenuAtom);
  if (menu === null) return null;
  return <MenuPopover menu={menu} />;
}

function MenuPopover({ menu }: { menu: OpenTargetMenuState }) {
  const close = useSetAtom(closeOpenTargetMenuAtom);
  const move = useSetAtom(moveOpenTargetAtom);
  const setIndex = useSetAtom(setOpenTargetIndexAtom);
  const execute = useSetAtom(executeOpenTargetAtom);
  const targets = useAtomValue(openTargetsAtom);
  const index = useAtomValue(openTargetIndexAtom);

  // A poll can drop the task's links, and ⌘1 / ⌥J move away from the runspace the menu describes;
  // either way keeping it up would leave a popover that no longer applies swallowing keys.
  const stale = useAtomValue(openTargetMenuStaleAtom);
  useEffect(() => {
    if (stale) close();
  }, [stale, close]);

  // Keys are taken at the window's capture phase rather than from a focused popover: the pane
  // re-runs `term.focus()` whenever the session status changes, so DOM focus here is a race the
  // menu loses. Capturing also runs ahead of the xterm textarea, so a swallowed key never reaches
  // the shell. Modifier chords fall through to use-shortcuts, which closes the menu via the stale
  // atom when they leave the runspace.
  useEffect(() => {
    if (stale) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") move("down");
      else if (e.key === "k" || e.key === "ArrowUp") move("up");
      else if (e.key === "Enter") execute();
      else if (e.key === "Escape") close();
      else if (e.key === "i") {
        // A task has at most one issue, so it gets a direct key while PRs do not.
        const issue = targets.findIndex((t) => t.kind === "issue");
        if (issue === -1) return;
        execute(issue);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [stale, move, execute, close, targets]);

  if (stale) return null;

  return (
    <PopoverMenu anchor={menu.anchor} onClose={close}>
      <OpenTargetList
        targets={targets}
        selectedIndex={index}
        onHover={setIndex}
        onSelect={execute}
        onBack={close}
      />
    </PopoverMenu>
  );
}
