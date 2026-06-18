import { useAtom } from "jotai";
import { textViewModeAtom, type TextViewMode } from "@/features/text-memory/store";
import { cn } from "@/lib/utils";

const ITEMS: { value: TextViewMode; label: string }[] = [
  { value: "record", label: "Records" },
  { value: "intent_seed", label: "Intent Seeds" },
  { value: "all", label: "All Artifacts" },
];

export function TextMemorySidebar() {
  const [viewMode, setViewMode] = useAtom(textViewModeAtom);

  return (
    <div className="py-2">
      <div className="px-2 pb-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        Personal
      </div>
      <div className="flex flex-col gap-1">
        {ITEMS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => setViewMode(item.value)}
            className={cn(
              "rounded-md px-2.5 py-2 text-left text-[12px] transition-colors",
              viewMode === item.value
                ? "bg-white/[0.1] text-foreground"
                : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
