import { useAtom, useSetAtom } from "jotai";
import { PlusIcon, RefreshIcon } from "@/components/icons";
import {
  refreshWorkboardAtom,
  workboardSearchAtom,
  workboardTrackOpenAtom,
} from "@/stores/workboard";

export function WorkBoardHeader() {
  const [search, setSearch] = useAtom(workboardSearchAtom);
  const setTrackOpen = useSetAtom(workboardTrackOpenAtom);
  const refresh = useSetAtom(refreshWorkboardAtom);

  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-2">
      <button
        onClick={() => setTrackOpen(true)}
        className="flex h-7 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
        title="Track Issue"
      >
        <PlusIcon size={13} />
        <span>Track Issue</span>
      </button>
      <button
        onClick={() => refresh()}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
        title="Refresh"
      >
        <RefreshIcon size={14} />
      </button>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search tasks"
        className="h-7 min-w-0 flex-1 rounded-md border border-white/[0.08] bg-white/[0.06] px-2.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-white/[0.18]"
      />
    </div>
  );
}
