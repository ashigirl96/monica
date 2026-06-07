import type { ComponentType } from "react";
import {
  DashboardIcon,
  ProjectHomeIcon,
  WorkBoardIcon,
  WorkBenchIcon,
} from "@/components/icons";
import type { SpaceId } from "@/stores/space";

type SpaceIcon = ComponentType<{ size?: number; strokeWidth?: number }>;

export type SpaceConfig = {
  id: SpaceId;
  icon: SpaceIcon;
  label: string;
  sidebar?: ComponentType;
  content: ComponentType;
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
function WorkBoardSidebar() {
  return <Placeholder name="Board Sidebar" />;
}
function WorkBoardContent() {
  return <Placeholder name="Work Board" />;
}
function WorkBenchContent() {
  return <Placeholder name="Work Bench" />;
}

export const spaces: SpaceConfig[] = [
  {
    id: "dashboard",
    icon: DashboardIcon,
    label: "Dashboard",
    content: DashboardContent,
  },
  {
    id: "project",
    icon: ProjectHomeIcon,
    label: "Project Home",
    sidebar: ProjectSidebar,
    content: ProjectContent,
  },
  {
    id: "work-board",
    icon: WorkBoardIcon,
    label: "Work Board",
    sidebar: WorkBoardSidebar,
    content: WorkBoardContent,
  },
  {
    id: "work-bench",
    icon: WorkBenchIcon,
    label: "Work Bench",
    content: WorkBenchContent,
  },
];

export function getSpaceConfig(id: SpaceId): SpaceConfig {
  return spaces.find((s) => s.id === id)!;
}
