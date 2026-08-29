import { focusManager, QueryClient } from "@tanstack/react-query";

export const queryKeys = {
  note: (id: string) => ["note", id] as const,
  essays: () => ["essays"] as const,
  projects: () => ["projects"] as const,
  projectPrimary: (projectId: string) => ["project-primary", projectId] as const,
  projectNotes: (projectId: string) => ["project-notes", projectId] as const,
  dailyNote: (date: string) => ["daily-note", date] as const,
  dailyDates: () => ["daily-dates"] as const,
  notesToday: () => ["notes-today"] as const,
};

// TanStack Query v5 は visibilitychange しか購読しない（v4 で focus を意図的に外した）。
// Monica デスクトップやエディタからブラウザへ戻るときウィンドウは可視のままなので
// visibilitychange が発火せず、復帰時の再フェッチが不発になる。focus を足して起点を増やす。
// blur が要るのは dedupe の再武装のため: focusManager は状態が「変化」したときだけ購読者に
// 通知するので、false へ戻す機会が無いと内部フラグが true に張り付き、2 回目以降の focus が
// 握り潰されて再フェッチが死ぬ。
focusManager.setEventListener((handleFocus) => {
  let focused = document.visibilityState === "visible";
  const set = (next: boolean) => {
    if (next === focused) return;
    focused = next;
    handleFocus(next);
  };
  const onVisibility = () => set(document.visibilityState === "visible");
  const onFocus = () => set(true);
  const onBlur = () => set(false);
  window.addEventListener("visibilitychange", onVisibility, false);
  window.addEventListener("focus", onFocus, false);
  window.addEventListener("blur", onBlur, false);
  return () => {
    window.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
  };
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // staleTime は既定の 0 のまま = mount と focus のたびに必ず取り直す。素の fetch +
      // useEffect だった頃と同じ頻度で、note の採用ガード（usableServerDoc）が「cache は
      // 使えないのに fetch も走らない」で詰まらない前提でもある。
      refetchOnWindowFocus: true,
      // 既定の 3 回リトライは素の fetch だった頃のエラー表示タイミングを変えてしまう。
      retry: false,
    },
  },
});
