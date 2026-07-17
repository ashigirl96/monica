import { useSyncExternalStore } from "react";
import { AppShell } from "./components/app-shell";
import { DetailPage } from "./pages/detail";
import { ListPage } from "./pages/list";
import { NotesPage } from "./pages/notes";

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
  | { page: "notes"; id: string | null };

function parseRoute(pathname: string): Route {
  const explanation = pathname.match(/^\/explanations\/(.+)$/);
  if (explanation) return { page: "detail", id: explanation[1] };
  const notes = pathname.match(/^\/notes(?:\/([^/]+))?\/?$/);
  if (notes) return { page: "notes", id: notes[1] ?? null };
  return { page: "list" };
}

export function App() {
  const pathname = useSyncExternalStore(subscribe, getSnapshot);
  const route = parseRoute(pathname);

  return (
    <AppShell active={route.page === "notes" ? "notes" : "library"}>
      {route.page === "detail" ? (
        <DetailPage id={route.id} />
      ) : route.page === "notes" ? (
        <NotesPage id={route.id} />
      ) : (
        <ListPage />
      )}
    </AppShell>
  );
}
