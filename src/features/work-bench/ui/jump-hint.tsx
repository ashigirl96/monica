import { cn } from "@/lib/utils";

export function JumpHint({
  hint,
  ctrl,
  className,
}: {
  hint: string;
  ctrl?: boolean;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "pointer-events-none flex h-4 shrink-0 items-center justify-center rounded px-0.5",
        ctrl ? "min-w-6 gap-px" : "w-4",
        "bg-amber-300 font-mono text-[10px] leading-none font-bold text-black/85",
        "shadow-[0_0_10px] shadow-amber-300/50",
        "animate-in fade-in zoom-in-50 duration-150",
        className,
      )}
    >
      {ctrl && <span className="text-[9px]">⌃</span>}
      {hint}
    </kbd>
  );
}
