import { useAtomValue } from "jotai";
import { projectsAtom } from "@/stores/workboard";
import { FuzzyPickerModal } from "@/components/fuzzy-picker-modal";

export function ProjectFilterModal({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (project: string | null) => void;
}) {
  const projects = useAtomValue(projectsAtom);

  return (
    <FuzzyPickerModal
      items={projects.map((p) => ({ key: p.id, label: p.id }))}
      onSelect={onSelect}
      onClose={onClose}
      placeholder="Filter projects..."
      footer="↑↓ move · ⏎ select · ^w clear · esc/^c close"
    />
  );
}
