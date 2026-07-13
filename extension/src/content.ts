import { Readability } from "@mozilla/readability";

declare const window: Window & { __monicaTranslateRan?: boolean };

if (!window.__monicaTranslateRan) {
  window.__monicaTranslateRan = true;
  runTranslation();
}

function runTranslation() {
  const BLOCK_SELECTORS =
    "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, dd, dt, figcaption";

  const blocks = document.body.querySelectorAll(BLOCK_SELECTORS);
  let segId = 0;
  for (const el of blocks) {
    (el as HTMLElement).dataset.monicaSeg = String(segId++);
  }

  const clone = document.cloneNode(true) as Document;
  const article = new Readability(clone).parse();
  if (!article?.content) {
    console.warn("[monica-translate] Readability found no article content");
    return;
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(article.content, "text/html");
  const survivingSegs = new Set<number>();
  for (const el of parsed.querySelectorAll("[data-monica-seg]")) {
    const seg = Number((el as HTMLElement).dataset.monicaSeg);
    if (!Number.isNaN(seg)) {
      survivingSegs.add(seg);
    }
  }

  const segments: Array<{ seg: number; text: string }> = [];
  for (const el of blocks) {
    const seg = Number((el as HTMLElement).dataset.monicaSeg);
    if (!survivingSegs.has(seg)) continue;
    const text = (el.textContent ?? "").trim();
    if (text.length < 2) continue;
    segments.push({ seg, text });
  }

  if (segments.length === 0) {
    console.warn("[monica-translate] no segments to translate");
    return;
  }

  console.log(`[monica-translate] sending ${segments.length} segments`);
  chrome.runtime.sendMessage({ type: "translate", segments });

  chrome.runtime.onMessage.addListener(
    (message: { type: string; seg?: number; translation?: string; message?: string }) => {
      if (message.type === "translation" && message.seg != null && message.translation) {
        const el = document.querySelector(`[data-monica-seg="${message.seg}"]`);
        if (!el) return;
        if (el.nextElementSibling?.classList.contains("monica-translation")) return;

        const div = document.createElement("div");
        div.textContent = message.translation;
        div.className = "monica-translation";
        div.style.cssText =
          "color:#1a5fb4;margin:4px 0;white-space:pre-wrap;font-style:italic;opacity:0.9;";
        el.insertAdjacentElement("afterend", div);
      } else if (message.type === "done") {
        console.log("[monica-translate] done");
      } else if (message.type === "error") {
        console.error(`[monica-translate] error: ${message.message}`);
      }
    },
  );
}
