import { atom } from "jotai";
import {
  listTaskSummaries,
  getBoardColumns,
  listProjects,
  trackGithubIssue,
  type TaskSummaryRow,
  type BoardColumn,
  type ProjectEntry,
} from "@/commands/task";

export const boardColumnsAtom = atom<BoardColumn[]>([]);
export const taskSummariesAtom = atom<TaskSummaryRow[]>([]);
export const projectsAtom = atom<ProjectEntry[]>([]);
export const selectedProjectAtom = atom<string | null>(null);

export const loadBoardAtom = atom(null, async (_get, set) => {
  const [columns, summaries, projects] = await Promise.all([
    getBoardColumns(),
    listTaskSummaries(),
    listProjects(),
  ]);
  set(boardColumnsAtom, columns);
  set(taskSummariesAtom, summaries);
  set(projectsAtom, projects);
});

export const filteredTasksAtom = atom((get) => {
  const tasks = get(taskSummariesAtom);
  const project = get(selectedProjectAtom);
  if (!project) return tasks;
  return tasks.filter((t) => t.project === project);
});

export const columnTasksAtom = atom((get) => {
  const columns = get(boardColumnsAtom);
  const tasks = get(filteredTasksAtom);
  return columns.map((col) => ({
    ...col,
    tasks: tasks.filter((t) => col.statuses.includes(t.status)),
  }));
});

export const trackIssueAtom = atom(null, async (_get, set, input: { repo: string; number: number }) => {
  await trackGithubIssue(input.repo, input.number);
  const summaries = await listTaskSummaries();
  set(taskSummariesAtom, summaries);
});
