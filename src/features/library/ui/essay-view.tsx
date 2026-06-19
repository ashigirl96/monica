import { useAtomValue, useSetAtom } from "jotai";
import { essaysAtom, openArtifactTabAtom } from "@/features/library/store";

export function EssayView() {
  const essays = useAtomValue(essaysAtom);
  const openArtifact = useSetAtom(openArtifactTabAtom);

  if (essays.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-[13px] text-muted-foreground/40">No essays</span>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto px-4 py-3 scrollbar-hide">
      <div className="mx-auto flex max-w-2xl flex-col gap-0.5">
        {essays.map((essay) => (
          <button
            key={essay.id}
            onClick={() => openArtifact(essay.id)}
            className="group flex w-full flex-col gap-1 rounded-lg px-3 py-3 text-left transition-colors hover:bg-white/[0.04]"
          >
            <div className="flex items-baseline gap-3">
              <span className="text-[14px] font-medium text-foreground/90 group-hover:text-foreground">
                {essay.title}
              </span>
              <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground/30">
                {new Date(essay.updated_at).toLocaleDateString("ja-JP", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>
            {essay.body_preview && (
              <p className="line-clamp-2 text-[12px] leading-relaxed text-muted-foreground/50">
                {essay.body_preview}
              </p>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
