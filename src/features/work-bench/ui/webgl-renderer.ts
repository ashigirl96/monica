import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

type WebglHost = Pick<Terminal, "loadAddon" | "refresh" | "rows" | "element">;

export type WebglRendererHandle = {
  detach: () => void;
  /// False once the addon is gone with no reload pending (attach failed, or the
  /// context was lost while the pane was hidden); the pool re-attaches on acquire.
  isAttached: () => boolean;
};

// The addon's render layers tag their canvases with `xterm-*-layer`; the WebGL canvas
// itself is the only unclassed one. WebglAddon never exposes its GL context, and this
// is the least fragile way to reach it for an explicit release on dispose.
function findWebglCanvas(root: HTMLElement | undefined): HTMLCanvasElement | null {
  const screen = root?.querySelector(".xterm-screen");
  if (!screen) return null;
  for (const canvas of screen.querySelectorAll("canvas")) {
    if (canvas.className === "") return canvas;
  }
  return null;
}

/// Attach a WebGL renderer to an opened terminal; on detach (and on failure) xterm
/// falls back to the DOM renderer. Disposal also loses the GL context explicitly —
/// WebglAddon only drops its references, which would leave the context counting against
/// WKWebView's per-page cap (~16, LRU-evicted) until GC.
export function attachWebglRenderer(
  term: WebglHost,
  createAddon: () => WebglAddon = () => new WebglAddon(),
  schedule: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
): WebglRendererHandle {
  let addon: WebglAddon | null = null;
  let glCanvas: HTMLCanvasElement | null = null;
  let reloadId: number | null = null;
  let detached = false;

  // getClientRects is empty inside a display:none subtree; no element means a test
  // harness, which we treat as visible.
  const paneVisible = () => {
    const el = term.element;
    return !el || el.getClientRects().length > 0;
  };

  const disposeAddon = () => {
    const current = addon;
    addon = null;
    if (!current) return;
    try {
      current.dispose();
    } catch {
      // Terminal.dispose() may have disposed the addon already; dispose order between
      // the terminal and the pool release is not guaranteed on every unmount path.
    }
    glCanvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    glCanvas = null;
  };

  const load = () => {
    let next: WebglAddon | null = null;
    try {
      next = createAddon();
      next.onContextLoss(() => {
        disposeAddon();
        if (detached) return;
        // Recreating a context the browser just reclaimed for a pane nobody can see
        // would thrash against the per-page cap, so a hidden pane stays detached and
        // the pool re-attaches it on activation. A visible pane reloads via rAF, which
        // also defers until the window is drawable again (rAF halts while occluded);
        // a repeated loss re-fires this handler, so no retry cap is needed.
        if (!paneVisible()) return;
        reloadId = schedule(() => {
          reloadId = null;
          if (!detached && paneVisible()) load();
        });
      });
      term.loadAddon(next);
    } catch (e) {
      try {
        next?.dispose();
      } catch {
        // a partially-activated addon may throw on dispose too
      }
      console.warn("WebGL renderer unavailable, falling back to the DOM renderer:", e);
      return;
    }
    addon = next;
    glCanvas = findWebglCanvas(term.element);
    if (!glCanvas && term.element) {
      console.warn("WebGL canvas not found; its context will only be released by GC");
    }
    term.refresh(0, term.rows - 1);
  };

  load();

  return {
    detach: () => {
      if (detached) return;
      detached = true;
      if (reloadId !== null) {
        cancel(reloadId);
        reloadId = null;
      }
      disposeAddon();
    },
    isAttached: () => addon !== null || reloadId !== null,
  };
}

// Well under WKWebView's ~16-context cap, leaving headroom for contexts that are lost
// but not yet collected and for anything else on the page that needs WebGL.
const POOL_LIMIT = 8;

/// LRU pool of WebGL renderers keyed by terminal. Keeping the addon on recently active
/// panes makes switching back to them free — a fresh attach pays for context creation,
/// shader compilation and a full glyph-atlas rebuild (the atlas cache is refcounted and
/// dies with its last owner). Eviction only happens past POOL_LIMIT, which also keeps
/// the page clear of the context-cap eviction that used to blank long-hidden panes.
export function createWebglRendererPool(
  limit: number = POOL_LIMIT,
  attach: (term: WebglHost) => WebglRendererHandle = attachWebglRenderer,
) {
  const pool = new Map<WebglHost, WebglRendererHandle>();
  return {
    acquire(term: WebglHost): void {
      const existing = pool.get(term);
      if (existing?.isAttached()) {
        pool.delete(term);
        pool.set(term, existing);
        return;
      }
      // A dead entry (failed attach, or context lost while hidden) gets a fresh try.
      if (existing) {
        pool.delete(term);
        existing.detach();
      }
      pool.set(term, attach(term));
      for (const [oldest, handle] of pool) {
        if (pool.size <= limit) break;
        pool.delete(oldest);
        handle.detach();
      }
    },
    release(term: WebglHost): void {
      const handle = pool.get(term);
      if (!handle) return;
      pool.delete(term);
      handle.detach();
    },
  };
}

export const webglRendererPool = createWebglRendererPool();
