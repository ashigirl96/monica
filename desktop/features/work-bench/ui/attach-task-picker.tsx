import { useAtomValue, useSetAtom } from "jotai";
import { FuzzyPickerModal } from "@/components/fuzzy-picker-modal";
import { attachPickerTabIdAtom, attachTabToTaskAtom } from "@/features/work-bench/store";
import { taskSummariesAtom } from "@/stores/workboard";

export function AttachTaskPicker() {
  const tabId = useAtomValue(attachPickerTabIdAtom);
  if (tabId === null) return null;
  return <Picker tabId={tabId} />;
}

function Picker({ tabId }: { tabId: string }) {
  const setPickerTab = useSetAtom(attachPickerTabIdAtom);
  const attach = useSetAtom(attachTabToTaskAtom);
  const tasks = useAtomValue(taskSummariesAtom);

  const items = tasks
    .filter((t) => t.task_status !== "closed")
    .map((t) => ({ key: t.id, label: `${t.id}  ${t.title}` }));

  return (
    <FuzzyPickerModal
      items={items}
      placeholder="Attach this tab to a task..."
      onClose={() => setPickerTab(null)}
      onSelect={(taskId) => {
        if (taskId) void attach(tabId, taskId);
      }}
    />
  );
}
