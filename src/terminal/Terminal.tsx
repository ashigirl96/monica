import { useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

type SessionId = number;

const FONT_FAMILY = '"SF Mono", ui-monospace, Menlo, monospace';
const FONT_SIZE = 15;

export function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<SessionId | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let active = true;

    const term = new XtermTerminal({
      cursorBlink: true,
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      scrollback: 10000,
      allowProposedApi: true,
      theme: {
        background: "#0f111a",
        foreground: "#d6deeb",
        cursor: "#c792ea",
        cursorAccent: "#0f111a",
        selectionBackground: "#1d3b53",
      },
    });

    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(container);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("WebGL renderer unavailable, falling back to DOM:", err);
    }

    fitAddon.fit();

    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => {
      term.write(new Uint8Array(buf));
    };

    (async () => {
      try {
        const id = await invoke<SessionId>("terminal_open", {
          rows: term.rows,
          cols: term.cols,
          channel,
        });
        if (!active) {
          await invoke("terminal_close", { id }).catch(() => undefined);
          return;
        }
        sessionIdRef.current = id;
      } catch (err) {
        console.error("terminal_open failed", err);
      }
    })();

    const dataDisp = term.onData((data) => {
      const sid = sessionIdRef.current;
      if (sid === null) return;
      invoke("terminal_write", { id: sid, data }).catch((err) =>
        console.error("terminal_write failed", err),
      );
    });

    const resizeDisp = term.onResize(({ rows, cols }) => {
      const sid = sessionIdRef.current;
      if (sid === null) return;
      invoke("terminal_resize", { id: sid, rows, cols }).catch((err) =>
        console.error("terminal_resize failed", err),
      );
    });

    const onWindowResize = () => fitAddon.fit();
    window.addEventListener("resize", onWindowResize);

    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(container);

    return () => {
      active = false;
      window.removeEventListener("resize", onWindowResize);
      resizeObserver.disconnect();
      dataDisp.dispose();
      resizeDisp.dispose();
      const id = sessionIdRef.current;
      if (id !== null) {
        invoke("terminal_close", { id }).catch(() => undefined);
      }
      term.dispose();
    };
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-[#0f111a]">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
