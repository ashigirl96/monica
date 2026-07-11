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

function ModeLabel({ mode }: { mode: string }) {
  const color = mode === "diff" ? "text-accent-diff" : "text-accent-topic";
  return <span className={`font-mono text-xs uppercase tracking-widest ${color}`}>{mode}</span>;
}

function Card({
  item,
  onOpen,
  onMenu,
}: {
  item: Explanation;
  onOpen: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const edge = item.mode === "diff" ? "bg-accent-diff" : "bg-accent-topic";
  const hoverBorder =
    item.mode === "diff" ? "hover:border-accent-diff/40" : "hover:border-accent-topic/40";
  const ghostHover =
    item.mode === "diff" ? "group-hover:text-accent-diff/70" : "group-hover:text-accent-topic/70";

  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={onMenu}
      className={`group relative flex cursor-pointer flex-col gap-2 overflow-hidden rounded-lg border bg-card px-5 py-4 text-left transition-all hover:shadow-md ${hoverBorder}`}
    >
      <div className={`absolute inset-y-0 left-0 w-1 ${edge}`} />
      <div className="flex items-baseline justify-between gap-3">
        <ModeLabel mode={item.mode} />
        <span
          className={`font-mono text-lg text-muted-foreground/25 transition-colors ${ghostHover}`}
        >
          {item.id}
        </span>
      </div>
      <span className="line-clamp-2 min-h-[2.6em] text-base font-medium leading-snug">
        {item.title}
      </span>
      <span className="text-xs text-muted-foreground" title={formatDate(item.created_at)}>
        {formatRelative(item.created_at)}
      </span>
    </button>
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
      (e) => e.title.toLowerCase().includes(q) || e.id.toLowerCase().includes(q),
    );
  }, [explanations, query]);

  return (
    <>
      <header className="sticky top-0 z-10 flex min-h-12 items-center gap-3 border-b bg-background/80 px-5 backdrop-blur-sm">
        <span className="text-sm font-semibold tracking-tight">Explanations</span>
        {explanations.length > 0 && (
          <span className="font-mono text-xs text-muted-foreground">
            {query ? `${filtered.length}/${explanations.length}` : explanations.length}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 transition-colors focus-within:border-foreground/25">
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
            className="w-44 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
          />
          <kbd className="rounded border px-1.5 font-mono text-[0.6rem] text-muted-foreground/60">
            /
          </kbd>
        </div>
      </header>

      <main className="flex-1 px-5 py-6">
        {loading ? (
          <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
            <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
            Loading&hellip;
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </div>
        ) : explanations.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-20 text-center">
            <div className="flex size-11 items-center justify-center rounded-full bg-muted">
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
              <p className="text-sm font-medium">No explanations yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Create one with{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  monica explain new
                </code>
              </p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            No matches for &ldquo;{query}&rdquo;
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((e) => (
              <Card
                key={e.id}
                item={e}
                onOpen={() => navigate(`/explanations/${e.id}`)}
                onMenu={(ev) => {
                  ev.preventDefault();
                  setMenu({ x: ev.clientX, y: ev.clientY, item: e });
                }}
              />
            ))}
          </div>
        )}
      </main>

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 w-48 rounded-md border bg-card p-1 shadow-xl"
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
            className="flex w-full items-center rounded px-2.5 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null);
              window.open(`/explanations/${menu.item.id}/artifact`, "_blank");
            }}
            className="flex w-full items-center rounded px-2.5 py-1.5 text-sm transition-colors hover:bg-muted"
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
            className="flex w-full items-center rounded px-2.5 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive/10"
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
