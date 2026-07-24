import { EssayEditorPage } from "./editor";
import { EssaysListPage } from "./list";

export function EssaysPage({ id }: { id: string | null }) {
  return id === null ? <EssaysListPage /> : <EssayEditorPage id={id} />;
}
