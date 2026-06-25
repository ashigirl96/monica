import mermaid from "mermaid";
import { useEffect, useId, useState } from "react";

// mermaid.render mutates a shared temp node, so serialize renders to avoid concurrent diagrams
// clobbering each other. `suppressErrorRendering` keeps mermaid from injecting its own error SVG —
// we fall back to the raw fenced block instead.
let queue: Promise<unknown> = Promise.resolve();

function renderDiagram(id: string, code: string, theme: "dark" | "default"): Promise<string> {
  const run = queue.then(async () => {
    mermaid.initialize({
      startOnLoad: false,
      theme,
      securityLevel: "strict",
      suppressErrorRendering: true,
    });
    const { svg } = await mermaid.render(id, code);
    return svg;
  });
  queue = run.catch(() => {});
  return run;
}

export default function Mermaid({ code }: { code: string }) {
  const renderId = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    const theme = document.documentElement.classList.contains("dark") ? "dark" : "default";
    renderDiagram(renderId, code, theme)
      .then((out) => !cancelled && setSvg(out))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [code, renderId]);

  if (failed) {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    );
  }
  if (svg === null) {
    return <div className="py-2 text-xs text-muted-foreground/50">Rendering diagram…</div>;
  }
  // svg comes from mermaid rendered with securityLevel "strict", so it is already sanitized.
  return <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />;
}
