import { useAtomValue } from "jotai";
import { libraryViewAtom, activeLibraryTabAtom } from "@/features/library/store";
import { TimelineView } from "./timeline";
import { EssayView } from "./essay-view";
import { IntentView } from "./intent-view";
import { Writer } from "./writer";

function LibraryContent() {
  const activeTab = useAtomValue(activeLibraryTabAtom);

  if (activeTab.kind === "draft") {
    return <Writer mode="draft" draftId={activeTab.draftId} />;
  }

  if (activeTab.kind === "artifact") {
    return <Writer mode="artifact" artifactId={activeTab.artifactId} />;
  }

  return <HomeView />;
}

function HomeView() {
  const view = useAtomValue(libraryViewAtom);

  switch (view) {
    case "timeline":
      return <TimelineView />;
    case "essay":
      return <EssayView />;
    case "intent":
      return <IntentView />;
  }
}

export default LibraryContent;
