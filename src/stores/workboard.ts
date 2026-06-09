import { atom } from "jotai";
import {
  listTaskSummaries,
  getBoardColumns,
  type TaskSummaryRow,
  type BoardColumn,
} from "@/commands/task";

export const boardColumnsAtom = atom<BoardColumn[]>([]);
export const taskSummariesAtom = atom<TaskSummaryRow[]>([]);

export const loadBoardAtom = atom(null, async (_get, set) => {
  const [columns, summaries] = await Promise.all([
    getBoardColumns(),
    listTaskSummaries(),
  ]);
  set(boardColumnsAtom, columns);
  set(taskSummariesAtom, summaries);
});

export const columnTasksAtom = atom((get) => {
  const columns = get(boardColumnsAtom);
  const tasks = get(taskSummariesAtom);
  return columns.map((col) => ({
    ...col,
    tasks: tasks.filter((t) => col.statuses.includes(t.status)),
  }));
});
