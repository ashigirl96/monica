import { useAtomValue, useSetAtom } from "jotai";
import { intentsAtom, openArtifactTabAtom } from "@/features/library/store";

export function IntentView() {
  const groups = useAtomValue(intentsAtom);
  const openArtifact = useSetAtom(openArtifactTabAtom);

  if (groups.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-[13px] text-muted-foreground/40">No intents</span>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto px-4 py-3 scrollbar-hide">
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        {groups.map((group) => (
          <div key={group.project_id ?? "__unassigned"} className="flex flex-col gap-0.5">
            <span className="mb-1 px-3 text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
              {group.project_id ?? "Unassigned"}
            </span>
            {group.items.map((item) => (
              <button
                key={item.id}
                onClick={() => openArtifact(item.id)}
                className="group flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
              >
                <span className="text-[13px] font-medium text-foreground/90 group-hover:text-foreground">
                  {item.title}
                </span>
                {item.body_preview && (
                  <p className="line-clamp-1 text-[11px] text-muted-foreground/40">
                    {item.body_preview}
                  </p>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
