import { lazy, Suspense } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "./markdown-components";

// Math (remark-math + rehype-katex + katex CSS) is heavy and rarely used, so it lives in a lazy
// chunk loaded only for pages that actually contain `$…$` / `$$…$$`.
const MathMarkdown = lazy(() => import("./markdown-math"));
const MATH_RE = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$/;

function BaseMarkdown({ body }: { body: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {body}
    </Markdown>
  );
}

// Generic markdown reader: a body string → GFM + lazy math/code/diagrams. Used by the Workbench
// plan preview and other markdown surfaces. `[[wikilink]]` in-app navigation is layered on next.
export default function MarkdownView({ body }: { body: string }) {
  return (
    <article className="notebook-md">
      {MATH_RE.test(body) ? (
        <Suspense fallback={<BaseMarkdown body={body} />}>
          <MathMarkdown body={body} />
        </Suspense>
      ) : (
        <BaseMarkdown body={body} />
      )}
    </article>
  );
}
