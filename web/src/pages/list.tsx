import { useEffect, useMemo, useRef, useState } from "react";
import { listExplanations } from "@/api";
import { navigate } from "@/app";
import { DeleteDialog } from "@/components/delete-dialog";
import { formatDate, formatRelative } from "@/format";
import type { Explanation } from "@/types.gen";

interface ContextMenuState {
  x: number;
  y: number;
  item: Explanation;
}

function Entry({
  item,
  onOpen,
  onMenu,
}: {
  item: Explanation;
  onOpen: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const modeColor = item.mode === "diff" ? "text-accent-diff" : "text-accent-topic";
  const titleHover =
    item.mode === "diff" ? "group-hover:text-accent-diff" : "group-hover:text-accent-topic";

  return (
    <li>
      <a
        href={`/explanations/${item.id}`}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onOpen();
        }}
        onContextMenu={onMenu}
        className="group flex items-start gap-6 rounded-lg border bg-card px-5 py-5 transition-colors hover:border-border/80 hover:shadow-sm"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2.5">
            <span className={`font-mono text-[0.7rem] uppercase tracking-widest ${modeColor}`}>
              {item.mode}
            </span>
            {item.repo_name && (
              <span className="truncate font-mono text-xs text-muted-foreground/70">
                {item.repo_name}
              </span>
            )}
          </div>
          <h2
            className={`mt-1.5 text-[1.3rem] font-medium leading-snug transition-colors ${titleHover}`}
          >
            {item.title}
          </h2>
          {item.summary && (
            <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
              {item.summary}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 pt-1">
          <span className="font-mono text-xs text-muted-foreground/50">{item.id}</span>
          <time
            dateTime={item.created_at}
            className="text-xs text-muted-foreground/70"
            title={formatDate(item.created_at)}
          >
            {formatRelative(item.created_at)}
          </time>
        </div>
      </a>
    </li>
  );
}

export function ListPage() {
  const [explanations, setExplanations] = useState<Explanation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Explanation | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listExplanations()
      .then(setExplanations)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Unknown error"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "/" && document.activeElement !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!menu) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenu(null);
    }
    function onScroll() {
      setMenu(null);
    }
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return explanations;
    return explanations.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q) ||
        (e.repo_name?.toLowerCase().includes(q) ?? false),
    );
  }, [explanations, query]);

  return (
    <>
      <header className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-[860px] items-center gap-3 px-6">
          <a
            href="/"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              navigate("/");
            }}
            className="flex items-center gap-2"
          >
            <img src="/favicon.png" alt="" className="size-6" />
            <h1 className="text-lg font-medium tracking-tight">Monica Library</h1>
          </a>
          <div className="ml-auto flex items-center gap-2">
            <svg
              className="size-3.5 shrink-0 text-muted-foreground/60"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
              />
            </svg>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  e.currentTarget.blur();
                }
              }}
              placeholder="Search"
              className="w-28 border-b border-transparent bg-transparent pb-0.5 text-sm outline-none transition-all placeholder:text-muted-foreground/50 focus:w-44 focus:border-accent sm:w-36 sm:focus:w-56"
            />
            <kbd className="rounded border px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground/50">
              /
            </kbd>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[860px] flex-1 px-6 pb-24 pt-2">
        {loading ? (
          <div className="flex items-center justify-center gap-2.5 py-28 text-sm text-muted-foreground">
            <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
            Loading&hellip;
          </div>
        ) : error ? (
          <div className="mt-8 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </div>
        ) : explanations.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-28 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <svg
                className="size-5 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                />
              </svg>
            </div>
            <div>
              <p className="text-lg">No explanations yet</p>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Create one with{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  monica explain new
                </code>
              </p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-24 text-center text-sm text-muted-foreground">
            No matches for &ldquo;{query}&rdquo;
          </div>
        ) : (
          <ol className="flex flex-col gap-3">
            {filtered.map((e) => (
              <Entry
                key={e.id}
                item={e}
                onOpen={() => navigate(`/explanations/${e.id}`)}
                onMenu={(ev) => {
                  ev.preventDefault();
                  setMenu({ x: ev.clientX, y: ev.clientY, item: e });
                }}
              />
            ))}
          </ol>
        )}
      </main>

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 w-48 rounded-lg border bg-card p-1 shadow-lg"
          style={{
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 130),
          }}
        >
          <button
            type="button"
            onClick={() => {
              setMenu(null);
              navigate(`/explanations/${menu.item.id}`);
            }}
            className="flex w-full items-center rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null);
              window.open(`/explanations/${menu.item.id}/artifact`, "_blank");
            }}
            className="flex w-full items-center rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            Open artifact in new tab
          </button>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => {
              setDeleteTarget(menu.item);
              setMenu(null);
            }}
            className="flex w-full items-center rounded-md px-2.5 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive/10"
          >
            Delete&hellip;
          </button>
        </div>
      )}

      {deleteTarget && (
        <DeleteDialog
          title={deleteTarget.title}
          id={deleteTarget.id}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setExplanations((prev) => prev.filter((x) => x.id !== deleteTarget.id));
            setDeleteTarget(null);
          }}
        />
      )}
    </>
  );
}
