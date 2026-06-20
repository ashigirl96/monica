import { lazy, type ComponentType } from "react";
import { LibraryIcon, WorkBoardIcon, WorkBenchIcon } from "@/components/icons";
import type { SpaceId } from "@/stores/space";
import { WorkBenchSidebar } from "@/features/work-bench/ui/sidebar";
import { WorkBenchHeader } from "@/features/work-bench/ui/header";
import { WorkBoardHeader } from "@/features/work-board/ui/header";
import { WorkBoardSidebar } from "@/features/work-board/ui/sidebar";

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

function EmptyHeader() {
  return null;
}

function EmptyContent() {
  return null;
}

export const spaces: SpaceConfig[] = [
  {
    id: "work-board",
    icon: WorkBoardIcon,
    label: "Work Board",
    sidebar: WorkBoardSidebar,
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
  {
    id: "library",
    icon: LibraryIcon,
    label: "Library",
    header: EmptyHeader,
    content: EmptyContent,
  },
];

export function getSpaceConfig(id: SpaceId): SpaceConfig {
  return spaces.find((s) => s.id === id)!;
}
