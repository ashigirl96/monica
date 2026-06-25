import { commands, type NotebookPageRow, type NotebookSummary } from "./bindings";
import { unwrap } from "./unwrap";

export type { NotebookPageRow, NotebookSummary };

export function listNotebooks() {
  return unwrap(commands.listNotebooks());
}

export function getNotebookPages(notebookId: string) {
  return unwrap(commands.getNotebookPages(notebookId));
}
