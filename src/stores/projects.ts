import { atom } from "jotai";
import { atomWithQuery } from "jotai-tanstack-query";
import { listProjects } from "@/commands/task";
import { queryKeys } from "@/stores/query-keys";

const projectsQueryAtom = atomWithQuery(() => ({
  queryKey: queryKeys.projects.list(),
  queryFn: () => listProjects(),
}));

export const projectsAtom = atom((get) => get(projectsQueryAtom).data ?? []);
