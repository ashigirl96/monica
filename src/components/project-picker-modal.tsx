import { useAtomValue } from "jotai";
import { FuzzyPickerModal } from "@/components/fuzzy-picker-modal";
import { projectsAtom } from "@/stores/projects";

export function ProjectPickerModal({
  onClose,
  onSelect,
  placeholder = "Filter projects...",
  footer = "↑↓ move · ⏎ select · ^w clear · esc/^c close",
}: {
  onClose: () => void;
  onSelect: (projectId: string | null) => void;
  placeholder?: string;
  footer?: string;
}) {
  const projects = useAtomValue(projectsAtom);

  return (
    <FuzzyPickerModal
      items={projects.map((project) => ({ key: project.id, label: project.id }))}
      onSelect={onSelect}
      onClose={onClose}
      placeholder={placeholder}
      footer={footer}
    />
  );
}
