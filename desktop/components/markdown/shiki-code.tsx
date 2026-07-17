import ShikiHighlighter from "react-shiki";

// Full react-shiki bundle: every language shiki ships is available, each lazy-loaded on first use.
// This module is itself lazy (loaded only when a fenced block with a language appears), so the
// shiki runtime stays out of the main bundle and out of text-only pages.
export default function ShikiCode({ language, code }: { language: string; code: string }) {
  return (
    <ShikiHighlighter language={language} theme="github-dark">
      {code}
    </ShikiHighlighter>
  );
}
