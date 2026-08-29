import { useCallback } from "react";
import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  dailyNoteDates,
  getDailyNote,
  getNote,
  getNotesToday,
  listEssays,
  listProjectNotes,
  listProjects,
  primaryNote,
} from "@/api";
import { queryKeys } from "@/query";
import type { Note, NotePage, NoteSummary } from "@/types.gen";

/** 開いている note 本文。`enabled` は id が未確定（primary へ委譲中など）のとき false。 */
export function useNoteQuery(id: string | null) {
  return useQuery({
    queryKey: queryKeys.note(id ?? ""),
    queryFn: () => getNote(id as string),
    enabled: id !== null,
  });
}

/** daily は GET ではなく PUT の get-or-create（開く = 作る）。既存 note があるときは
 * updated_at を触らないので、復帰のたびに叩いても版は進まない。 */
export function useDailyNoteQuery(date: string | null) {
  return useQuery({
    queryKey: queryKeys.dailyNote(date ?? ""),
    queryFn: () => getDailyNote(date as string),
    enabled: date !== null,
  });
}

export function useDailyDatesQuery() {
  return useQuery({ queryKey: queryKeys.dailyDates(), queryFn: dailyNoteDates });
}

/** logical today は復帰時に取り直さない — 日付境界を跨いだ瞬間に勝手に別日へ飛ぶのを避ける。 */
export function useNotesTodayQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.notesToday(),
    queryFn: getNotesToday,
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

export function useEssaysQuery() {
  return useQuery({ queryKey: queryKeys.essays(), queryFn: listEssays });
}

export function useProjectsQuery() {
  return useQuery({ queryKey: queryKeys.projects(), queryFn: listProjects });
}

/** project の primary note の get-or-create。daily と同じく PUT だが冪等。 */
export function useProjectPrimaryQuery(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectPrimary(projectId),
    queryFn: () => primaryNote(projectId),
  });
}

/** project note の時系列。offset ページネーションなので pageParam は読み込み済み件数。 */
export function useProjectNotesQuery(projectId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.projectNotes(projectId),
    queryFn: ({ pageParam }) => listProjectNotes(projectId, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) =>
      last.has_more ? pages.reduce((n, p) => n + p.items.length, 0) : undefined,
  });
}

/** API レスポンスの note をそのまま本文キャッシュへ置く。navigate 直後の loading を挟まない
 * （素の fetch だった頃の `noteRef.current?.id === id` early-return の代わり）。 */
export function useSeedNote() {
  const queryClient = useQueryClient();
  return useCallback(
    (note: Note) => queryClient.setQueryData(queryKeys.note(note.id), note),
    [queryClient],
  );
}

/** essay 一覧キャッシュの手動操作。一覧ページとエディタのサイドバーが共有する。 */
export function useEssaysCache() {
  const queryClient = useQueryClient();
  const patchEssays = useCallback(
    (update: (list: NoteSummary[] | null) => NoteSummary[] | null) => {
      queryClient.setQueryData(
        queryKeys.essays(),
        (list: NoteSummary[] | undefined) => update(list ?? null) ?? undefined,
      );
    },
    [queryClient],
  );
  const invalidateEssays = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: queryKeys.essays() }),
    [queryClient],
  );
  return { patchEssays, invalidateEssays };
}

/** project note 一覧（infinite query）の手動操作。ページ構造を保ったまま items を書き換える。 */
export function useProjectNotesCache(projectId: string) {
  const queryClient = useQueryClient();
  const patchProjectNotes = useCallback(
    (update: (items: NoteSummary[]) => NoteSummary[]) => {
      queryClient.setQueryData(
        queryKeys.projectNotes(projectId),
        (data: InfiniteData<NotePage> | undefined) =>
          data === undefined
            ? data
            : {
                ...data,
                pages: data.pages.map((page) => ({ ...page, items: update(page.items) })),
              },
      );
    },
    [queryClient, projectId],
  );
  const invalidateProject = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectNotes(projectId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectPrimary(projectId) });
  }, [queryClient, projectId]);
  return { patchProjectNotes, invalidateProject };
}
