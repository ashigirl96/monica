import { useAtom } from "jotai";
import { activeSpaceAtom } from "@/stores/space";
import { spaces } from "@/spaces/registry";
import { TRAFFIC_LIGHT_ZONE_HEIGHT } from "@/lib/layout";
import { cn } from "@/lib/utils";

export function SpaceNav() {
  const [activeSpace, setActiveSpace] = useAtom(activeSpaceAtom);

  return (
    <div className="flex w-12 flex-shrink-0 flex-col items-center">
      <div
        className="w-full flex-shrink-0"
        style={{ height: TRAFFIC_LIGHT_ZONE_HEIGHT }}
        data-tauri-drag-region
      />
      <div className="flex w-full flex-col items-center gap-0.5">
        {spaces.map((space) => {
          const Icon = space.icon;
          const isActive = activeSpace === space.id;
          return (
            <button
              key={space.id}
              onClick={() => setActiveSpace(space.id)}
              className={cn(
                "relative flex h-8 w-8 items-center justify-center rounded-lg",
                "text-muted-foreground transition-all duration-150",
                "hover:bg-white/[0.08] hover:text-foreground",
                isActive && "bg-white/[0.12] text-foreground shadow-sm",
              )}
              title={space.label}
            >
              <Icon size={18} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
