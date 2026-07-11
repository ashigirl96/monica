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

function Route({ pathname }: { pathname: string }) {
  const match = pathname.match(/^\/explanations\/(.+)$/);
  if (match) return <DetailPage id={match[1]} />;
  return <ListPage />;
}

export function App() {
  const pathname = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Route pathname={pathname} />
      </div>
    </div>
  );
}
