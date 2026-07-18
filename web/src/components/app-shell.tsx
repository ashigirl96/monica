import { type ReactNode, useEffect, useState } from "react";
import { spaLinkClick } from "@/app";
import { setThemePref, themePref, type ThemePref } from "@/theme";

function RailLink({
  to,
  label,
  active,
  children,
}: {
  to: string;
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={to}
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      onClick={spaLinkClick(to)}
      className={`flex size-9 items-center justify-center rounded-lg transition-colors ${
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground/60 hover:bg-muted/60 hover:text-muted-foreground"
      }`}
    >
      {children}
    </a>
  );
}

const THEME_CYCLE: ThemePref[] = ["system", "light", "dark"];

const THEME_ICONS: Record<ThemePref, ReactNode> = {
  // 半分塗りの円 = OS 追従
  system: (
    <svg
      className="size-[18px]"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.8}
    >
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 3.75v16.5A8.25 8.25 0 0 0 12 3.75z" fill="currentColor" stroke="none" />
    </svg>
  ),
  light: (
    <svg
      className="size-[18px]"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.8}
    >
      <circle cx="12" cy="12" r="4" />
      <path
        strokeLinecap="round"
        d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"
      />
    </svg>
  ),
  dark: (
    <svg
      className="size-[18px]"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.8}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"
      />
    </svg>
  ),
};

function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(themePref);
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(pref) + 1) % THEME_CYCLE.length];
  return (
    <button
      type="button"
      aria-label={`Theme: ${pref} (switch to ${next})`}
      title={`Theme: ${pref} (switch to ${next})`}
      onClick={() => {
        setThemePref(next);
        setPref(next);
      }}
      className="mt-auto flex size-9 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-muted-foreground"
    >
      {THEME_ICONS[pref]}
    </button>
  );
}

export function AppShell({
  active,
  children,
}: {
  active: "notes" | "library" | "settings";
  children: ReactNode;
}) {
  // alt+b の zen mode: nav rail と、group-data-[zen]/shell で反応する
  // ページ側 sidebar をまとめて隠し、editor だけにする
  const [zen, setZen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.code !== "KeyB") return;
      e.preventDefault();
      e.stopPropagation();
      setZen((z) => !z);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="group/shell flex min-h-dvh" data-zen={zen ? "" : undefined}>
      <nav
        className={`sticky top-0 z-20 flex h-dvh shrink-0 flex-col items-center gap-1.5 overflow-hidden bg-background pt-3 pb-4 transition-[width] duration-200 motion-reduce:transition-none ${zen ? "w-0" : "w-12 border-r"}`}
      >
        <img src="/favicon.png" alt="" className="mb-3 size-7" />
        <RailLink to="/notes" label="Notes" active={active === "notes"}>
          <svg
            className="size-[18px]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 20l1.2-4.4L16.6 4.2a2.1 2.1 0 013 3L8.2 18.6 4 20zM14.5 6.3l3 3"
            />
          </svg>
        </RailLink>
        <RailLink to="/explanations" label="Library" active={active === "library"}>
          <svg
            className="size-[18px]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6.5c-1.5-1.3-3.5-2-5.5-2-1 0-2 .2-2.5.4v13.2c.5-.2 1.5-.4 2.5-.4 2 0 4 .7 5.5 2m0-13.2c1.5-1.3 3.5-2 5.5-2 1 0 2 .2 2.5.4v13.2c-.5-.2-1.5-.4-2.5-.4-2 0-4 .7-5.5 2m0-13.2v13.2"
            />
          </svg>
        </RailLink>
        <RailLink to="/settings" label="Settings" active={active === "settings"}>
          <svg
            className="size-[18px]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <circle cx="12" cy="12" r="3" />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
            />
          </svg>
        </RailLink>
        <ThemeToggle />
      </nav>
      <div className="flex min-h-dvh min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
