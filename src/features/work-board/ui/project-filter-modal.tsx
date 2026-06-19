import { ProjectPickerModal } from "@/components/project-picker-modal";

export function ProjectFilterModal({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (project: string | null) => void;
}) {
  return <ProjectPickerModal onClose={onClose} onSelect={onSelect} />;
}
