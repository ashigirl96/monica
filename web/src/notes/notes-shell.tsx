import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { altOnly } from "@/keys";
import "./notes.css";

type NoteDensity = "relaxed" | "compact";

const DENSITY_KEY = "monica-notes-density";

function readDensity(): NoteDensity {
  return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "relaxed";
}

const SIDEBAR_KEY = "monica-notes-sidebar-w";
const SIDEBAR_DEFAULT = 400;
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 720;

const clampSidebar = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));

function readSidebarWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_KEY));
  return raw > 0 ? clampSidebar(raw) : SIDEBAR_DEFAULT;
}

/**
 * daily / essays / projects が共有する画面枠。サイドバー幅のドラッグリサイズ
 * （localStorage 永続化・ダブルクリックで既定幅に戻す）と ⌥D の density トグルを持つ。
 */
export function NotesShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const [sidebarWidth, setSidebarWidth] = useState<number>(readSidebarWidth);
  const [density, setDensity] = useState<NoteDensity>(readDensity);
  // ドラッグ開始時の座標と幅。null = ドラッグ中でない
  const [resizeStart, setResizeStart] = useState<{ x: number; w: number } | null>(null);
  const resizing = resizeStart !== null;

  useEffect(() => {
    // ドラッグ中は書かない。毎フレームの同期 I/O になるので、離した一度だけ永続化する
    if (resizing) return;
    localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth));
  }, [resizing, sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(DENSITY_KEY, density);
  }, [density]);

  useEffect(() => {
    if (resizeStart === null) return;
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      setResizeStart(null);
    };
    const onMove = (e: PointerEvent) => {
      // WKWebView は pointerup を取りこぼし buttons=0 の move が先に来ることがある
      if (e.buttons === 0) {
        stop();
        return;
      }
      // --sb-w は .notes-screen（= 本文の祖先）に載るので、1 フレームに複数届く
      // pointermove をそのまま反映すると ProseMirror 全体の style 再計算を余分に回す
      const width = clampSidebar(resizeStart.w + (e.clientX - resizeStart.x));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSidebarWidth(width));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizeStart]);

  useEffect(() => {
    // capture phase で登録する: エディタ（ProseMirror）に食われる前に横取りする
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || !altOnly(e)) return;
      if (e.code !== "KeyD") return;
      e.preventDefault();
      e.stopPropagation();
      setDensity((d) => (d === "compact" ? "relaxed" : "compact"));
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      className={`notes-screen relative flex h-dvh shrink-0 overflow-hidden ${
        resizing ? "cursor-col-resize select-none" : ""
      }`}
      style={{ "--sb-w": `${sidebarWidth}px` } as CSSProperties}
      data-density={density}
    >
      <aside
        className={`w-[var(--sb-w)] shrink-0 overflow-hidden border-r border-[var(--ink-border)] bg-[var(--desk)] group-data-[zen]/shell:w-0 group-data-[zen]/shell:border-r-0 ${
          resizing ? "" : "transition-[width] duration-200 motion-reduce:transition-none"
        }`}
      >
        {/* 開閉アニメーション中に中身が折り返さないよう幅は内側で固定する */}
        <div className="flex h-full w-[var(--sb-w)] flex-col">{sidebar}</div>
      </aside>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={(e) => {
          e.preventDefault();
          setResizeStart({ x: e.clientX, w: sidebarWidth });
        }}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        className="group/resize absolute inset-y-0 left-[var(--sb-w)] z-20 flex w-3 -translate-x-1/2 cursor-col-resize justify-center group-data-[zen]/shell:hidden"
      >
        <span
          className={`h-full w-0.5 transition-colors duration-100 ${
            resizing
              ? "bg-[var(--ink-muted)]"
              : "bg-transparent group-hover/resize:bg-[var(--ink-muted)]"
          }`}
        />
      </div>

      {children}
    </div>
  );
}
