import { lazy, Suspense } from "react";
import type { Components } from "react-markdown";

// mermaid and shiki (both heavy) load only when a diagram / highlighted code block is present.
const Mermaid = lazy(() => import("./mermaid"));
const ShikiCode = lazy(() => import("./shiki-code"));

const DiagramFallback = (
  <div className="py-2 text-xs text-muted-foreground/50">Loading diagram…</div>
);

function PlainCode({ code }: { code: string }) {
  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}

// Shared react-markdown overrides, used by both the plain and the math-enabled renderers.
export const markdownComponents: Components = {
  // react-markdown wraps block code in <pre>; unwrap it so `code` can emit the right block element
  // (shiki/mermaid/plain) without nesting it inside an extra, double-styled <pre>.
  pre: ({ children }) => <>{children}</>,
  code({ className, children }) {
    const raw = String(children);
    const lang = /language-(\w+)/.exec(className ?? "")?.[1];
    // Inline code carries no newline and no language fence; everything else is a block.
    if (!raw.includes("\n") && lang === undefined) {
      return <code className={className}>{children}</code>;
    }
    const code = raw.replace(/\n$/, "");
    if (lang === "mermaid") {
      return (
        <Suspense fallback={DiagramFallback}>
          <Mermaid code={code} />
        </Suspense>
      );
    }
    if (lang) {
      return (
        <Suspense fallback={<PlainCode code={code} />}>
          <ShikiCode language={lang} code={code} />
        </Suspense>
      );
    }
    return <PlainCode code={code} />;
  },
};
