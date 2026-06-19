import { lazy, type ComponentType } from "react";
import { LibraryIcon, WorkBoardIcon, WorkBenchIcon } from "@/components/icons";
import type { SpaceId } from "@/stores/space";
import { TabBar } from "@/components/tab-bar";
import { WorkBenchSidebar } from "@/features/work-bench/ui/sidebar";
import { WorkBenchHeader } from "@/features/work-bench/ui/header";
import { WorkBoardHeader } from "@/features/work-board/ui/header";

const LazyWorkBenchContent = lazy(() => import("@/features/work-bench/ui/content"));
const LazyWorkBoardContent = lazy(() => import("@/features/work-board/ui/content"));

type SpaceIcon = ComponentType<{ size?: number; strokeWidth?: number }>;

export type SpaceConfig = {
  id: SpaceId;
  icon: SpaceIcon;
  label: string;
  sidebar?: ComponentType;
  header: ComponentType;
  content: ComponentType;
  persistent?: boolean;
};

function Placeholder({ name }: { name: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {name}
    </div>
  );
}

function LibraryContent() {
  return <Placeholder name="Library" />;
}
export const spaces: SpaceConfig[] = [
  {
    id: "library",
    icon: LibraryIcon,
    label: "Library",
    header: TabBar,
    content: LibraryContent,
  },
  {
    id: "work-board",
    icon: WorkBoardIcon,
    label: "Work Board",
    header: WorkBoardHeader,
    content: LazyWorkBoardContent,
  },
  {
    id: "work-bench",
    icon: WorkBenchIcon,
    label: "Work Bench",
    sidebar: WorkBenchSidebar,
    header: WorkBenchHeader,
    content: LazyWorkBenchContent,
    persistent: true,
  },
];

export function getSpaceConfig(id: SpaceId): SpaceConfig {
  return spaces.find((s) => s.id === id)!;
}
