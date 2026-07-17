import { getDefaultStore } from "jotai";
import { BlockEditor } from "@shared/block-editor/block-editor";
import { journalDocAtom } from "@/features/journal/store";

export default function JournalContent() {
  const store = getDefaultStore();
  return (
    <div className="h-full overflow-y-auto">
      <BlockEditor
        className="min-h-full px-10 py-8"
        initialDoc={store.get(journalDocAtom)}
        autoFocus
        onUnmount={(doc) => store.set(journalDocAtom, doc)}
      />
    </div>
  );
}
