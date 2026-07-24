import { useSyncExternalStore } from "react";
import { AppShell } from "./components/app-shell";
import { DailyPage } from "./pages/daily";
import { DetailPage } from "./pages/detail";
import { EssaysPage } from "./pages/essays";
import { ListPage } from "./pages/list";
import { NotesPage } from "./pages/notes";
import { SettingsPage } from "./pages/settings";

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
}

function getSnapshot() {
  return window.location.pathname;
}

export function navigate(to: string, opts?: { replace?: boolean }) {
  if (opts?.replace) {
    window.history.replaceState(null, "", to);
  } else {
    window.history.pushState(null, "", to);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** <a> の onClick 用。修飾キー付きクリック（新規タブ等のネイティブ挙動）は素通しして SPA 遷移する */
export function spaLinkClick(to: string) {
  return (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
}

type Route =
  | { page: "list" }
  | { page: "detail"; id: string }
  | { page: "notes"; id: string | null }
  | { page: "daily"; date: string | null }
  | { page: "essays"; id: string | null }
  | { page: "settings" };

function parseRoute(pathname: string): Route {
  const explanation = pathname.match(/^\/explanations\/(.+)$/);
  if (explanation) return { page: "detail", id: explanation[1] };
  const notes = pathname.match(/^\/notes(?:\/([^/]+))?\/?$/);
  if (notes) return { page: "notes", id: notes[1] ?? null };
  // date の形式検証はしない（backend の is_valid_date が正 — 不正値は PUT が 422 を返し
  // DailyPage がエラー表示する）。フロントに日付パースを複製しない。
  const daily = pathname.match(/^\/daily(?:\/([^/]+))?\/?$/);
  if (daily) return { page: "daily", date: daily[1] ?? null };
  const essays = pathname.match(/^\/essays(?:\/([^/]+))?\/?$/);
  if (essays) return { page: "essays", id: essays[1] ?? null };
  if (/^\/settings\/?$/.test(pathname)) return { page: "settings" };
  return { page: "list" };
}

export function App() {
  const pathname = useSyncExternalStore(subscribe, getSnapshot);
  const route = parseRoute(pathname);

  return (
    <AppShell
      active={
        route.page === "notes" || route.page === "daily" || route.page === "essays"
          ? route.page
          : route.page === "settings"
            ? "settings"
            : "library"
      }
    >
      {route.page === "detail" ? (
        <DetailPage id={route.id} />
      ) : route.page === "notes" ? (
        <NotesPage id={route.id} />
      ) : route.page === "daily" ? (
        <DailyPage date={route.date} />
      ) : route.page === "essays" ? (
        <EssaysPage id={route.id} />
      ) : route.page === "settings" ? (
        <SettingsPage />
      ) : (
        <ListPage />
      )}
    </AppShell>
  );
}
