import { lazy, type ComponentType } from "react";
import { DashboardIcon, ProjectHomeIcon, WorkBoardIcon, WorkBenchIcon } from "@/components/icons";
import type { SpaceId } from "@/stores/space";
import { TabBar } from "@/components/tab-bar";
import { WorkBenchSidebar } from "@/spaces/work-bench/sidebar";
import { WorkBenchHeader } from "@/spaces/work-bench/header";

const LazyWorkBenchContent = lazy(() => import("@/spaces/work-bench/content"));
const LazyWorkBoardContent = lazy(() => import("@/spaces/work-board/content"));

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

function DashboardContent() {
  return <Placeholder name="Dashboard" />;
}
function ProjectSidebar() {
  return <Placeholder name="Project Sidebar" />;
}
function ProjectContent() {
  return <Placeholder name="Project" />;
}
export const spaces: SpaceConfig[] = [
  {
    id: "dashboard",
    icon: DashboardIcon,
    label: "Dashboard",
    header: TabBar,
    content: DashboardContent,
  },
  {
    id: "project",
    icon: ProjectHomeIcon,
    label: "Project Home",
    sidebar: ProjectSidebar,
    header: TabBar,
    content: ProjectContent,
  },
  {
    id: "work-board",
    icon: WorkBoardIcon,
    label: "Work Board",
    header: TabBar,
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
