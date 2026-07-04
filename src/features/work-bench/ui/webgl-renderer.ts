import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

type WebglHost = Pick<Terminal, "loadAddon" | "refresh" | "rows" | "element">;

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

/// Attach a WebGL renderer to an opened terminal and return its cleanup; on dispose
/// xterm falls back to the DOM renderer. Disposal also loses the GL context explicitly —
/// WebglAddon only drops its references, which would leave the context counting against
/// WKWebView's per-page cap (~16, LRU-evicted) until GC.
export function attachWebglRenderer(
  term: WebglHost,
  createAddon: () => WebglAddon = () => new WebglAddon(),
  schedule: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
): () => void {
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
        // rAF defers the reload until the window is drawable again (rAF halts while
        // occluded), and a repeated loss re-fires this handler, so no retry cap is
        // needed. A pooled-but-hidden pane keeps deferring: recreating a context the
        // browser just reclaimed would thrash against the per-page cap for a pane
        // nobody can see. The loop resumes and reloads when the pane is shown again.
        const reload = () => {
          reloadId = null;
          if (detached) return;
          if (!paneVisible()) {
            reloadId = schedule(reload);
            return;
          }
          load();
        };
        reloadId = schedule(reload);
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

  return () => {
    if (detached) return;
    detached = true;
    if (reloadId !== null) {
      cancel(reloadId);
      reloadId = null;
    }
    disposeAddon();
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
  attach: (term: WebglHost) => () => void = attachWebglRenderer,
) {
  const pool = new Map<WebglHost, () => void>();
  return {
    acquire(term: WebglHost): void {
      const existing = pool.get(term);
      if (existing) {
        pool.delete(term);
        pool.set(term, existing);
        return;
      }
      pool.set(term, attach(term));
      for (const [oldest, detach] of pool) {
        if (pool.size <= limit) break;
        pool.delete(oldest);
        detach();
      }
    },
    release(term: WebglHost): void {
      const detach = pool.get(term);
      if (!detach) return;
      pool.delete(term);
      detach();
    },
  };
}

export const webglRendererPool = createWebglRendererPool();
