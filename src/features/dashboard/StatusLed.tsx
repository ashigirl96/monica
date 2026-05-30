import { cn } from "@/lib/utils";
import { STATUS_META, statusColor } from "./statusMeta";
import type { DisplayStatus } from "./types";

interface StatusLedProps {
  status: DisplayStatus;
  size?: number;
  className?: string;
}

export function StatusLed({ status, size = 9, className }: StatusLedProps) {
  const color = statusColor(status);
  const pulse = STATUS_META[status].pulse;
  return (
    <span
      className={cn("relative inline-block shrink-0 rounded-full", className)}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        ["--led-glow" as string]: color,
        animation: pulse ? "led-pulse 1.6s ease-in-out infinite" : undefined,
        boxShadow: `0 0 5px 0 color-mix(in oklab, ${color} 70%, transparent)`,
      }}
    />
  );
}
