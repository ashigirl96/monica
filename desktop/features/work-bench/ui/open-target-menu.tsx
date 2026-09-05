import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { PopoverMenu } from "@/components/popover-menu";
import { OpenTargetList } from "@/components/open-target-list";
import {
  closeOpenTargetMenuAtom,
  executeOpenTargetAtom,
  moveOpenTargetAtom,
  openTargetMenuAtom,
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

  // A poll can drop the task or its links while the menu is up; leaving it open with no rows
  // would strand keyboard focus on an empty popover.
  const empty = targets.length === 0;
  useEffect(() => {
    if (empty) close();
  }, [empty, close]);
  if (empty) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "j" || e.key === "ArrowDown") move("down");
    else if (e.key === "k" || e.key === "ArrowUp") move("up");
    else if (e.key === "Enter") execute();
    else if (e.key === "Escape") close();
    else if (e.key === "i") {
      // A task has at most one issue, so it gets a direct key while PRs do not.
      const issue = targets.findIndex((t) => t.kind === "issue");
      if (issue !== -1) execute(issue);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <PopoverMenu anchor={menu.anchor} onClose={close} onKeyDown={onKeyDown} autoFocus>
      <OpenTargetList
        targets={targets}
        selectedIndex={menu.index}
        onHover={setIndex}
        onSelect={execute}
        onBack={close}
      />
    </PopoverMenu>
  );
}
