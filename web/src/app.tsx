import { useSyncExternalStore } from "react";
import { DetailPage } from "./pages/detail";
import { ListPage } from "./pages/list";

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
}

function getSnapshot() {
  return window.location.pathname;
}

export function navigate(to: string) {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function parseRoute(pathname: string): { page: "list" } | { page: "detail"; id: string } {
  const match = pathname.match(/^\/explanations\/(.+)$/);
  if (match) return { page: "detail", id: match[1] };
  return { page: "list" };
}

export function App() {
  const pathname = useSyncExternalStore(subscribe, getSnapshot);
  const route = parseRoute(pathname);

  return (
    <div className="flex min-h-full flex-col">
      {route.page === "detail" ? <DetailPage id={route.id} /> : <ListPage />}
    </div>
  );
}
