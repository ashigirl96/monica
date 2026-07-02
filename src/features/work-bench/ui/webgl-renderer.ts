import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

type WebglHost = Pick<Terminal, "loadAddon" | "refresh" | "rows">;

/// Attach a WebGL renderer to an opened terminal and return its cleanup. WKWebView caps
/// WebGL contexts per page (~16, LRU-evicted), so callers must keep the addon attached
/// only while the pane is visible; on dispose xterm falls back to the DOM renderer.
export function attachWebglRenderer(
  term: WebglHost,
  createAddon: () => WebglAddon = () => new WebglAddon(),
  schedule: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
): () => void {
  let addon: WebglAddon | null = null;
  let reloadId: number | null = null;
  let detached = false;

  const disposeAddon = () => {
    const current = addon;
    addon = null;
    if (!current) return;
    try {
      current.dispose();
    } catch {
      // Terminal.dispose() may have disposed the addon already: on unmount the terminal
      // effect's cleanup runs before the WebGL effect's cleanup (declaration order).
    }
  };

  const load = () => {
    let next: WebglAddon | null = null;
    try {
      next = createAddon();
      next.onContextLoss(() => {
        disposeAddon();
        if (detached) return;
        // rAF defers the reload until the window is drawable again (rAF halts while
        // occluded), and a repeated loss re-fires this handler, so no retry cap is needed.
        reloadId = schedule(() => {
          reloadId = null;
          if (!detached) load();
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
