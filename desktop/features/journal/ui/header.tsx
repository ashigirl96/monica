import { JournalIcon } from "@/components/icons";

export function JournalHeader() {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1" data-tauri-drag-region>
      <JournalIcon size={14} className="text-muted-foreground/70" />
      <span className="text-[13px] text-muted-foreground">Journal</span>
      <span className="ml-2 text-[11px] text-muted-foreground/40">in-memory</span>
    </div>
  );
}
