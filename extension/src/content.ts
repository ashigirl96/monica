// Firefox Translations の InPageTranslation 方式:
// 「本文抽出」はせず、DOM を TreeWalker で降りながら「子が全部テキスト or インライン要素」
// の要素を 1 翻訳単位として収集する。除外は明示的なタグ・属性のみ。
// viewport 内の単位を先に送り、streaming で画面から順に埋まるようにする。

const w = window as unknown as {
  __monicaTranslateUrl?: string;
  __monicaTranslateListening?: boolean;
  innerHeight: number;
};

const EXCLUDED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "code",
  "pre",
  "kbd",
  "samp",
  "var",
  "textarea",
  "input",
  "select",
  "button",
  "svg",
  "math",
  "iframe",
  "object",
  "embed",
  "canvas",
  "audio",
  "video",
]);

const MIN_TEXT_LENGTH = 3;

function isExcluded(el: Element): boolean {
  if (EXCLUDED_TAGS.has(el.tagName.toLowerCase())) return true;
  const translate = el.getAttribute("translate");
  if (translate === "no" || translate === "false") return true;
  if (el.classList.contains("notranslate")) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.classList.contains("monica-translation")) return true;
  return false;
}

function isHidden(el: Element): boolean {
  const style = getComputedStyle(el);
  return style.display === "none" || style.visibility === "hidden";
}

function isInlineElement(el: Element): boolean {
  const display = getComputedStyle(el).display;
  return display.startsWith("inline") || display === "contents";
}

/** 子が全部「テキスト or インライン要素」なら、この要素を 1 翻訳単位として扱える */
function hasOnlyInlineContent(el: Element): boolean {
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const childEl = child as Element;
    // 過去の実行で挿入した訳文は単位判定に影響させない
    if (childEl.classList.contains("monica-translation")) continue;
    if (isExcluded(childEl)) return false;
    if (!isInlineElement(childEl)) return false;
  }
  return true;
}

/** 挿入済みの訳文を除いた原文テキスト */
function unitText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const t of clone.querySelectorAll(".monica-translation")) {
    t.remove();
  }
  return (clone.textContent ?? "").trim();
}

function hasTranslatableText(el: Element): boolean {
  const text = unitText(el);
  if (text.length < MIN_TEXT_LENGTH) return false;
  // 数字・記号だけのブロック（日付、バージョン番号等）は送らない
  return /\p{L}/u.test(text);
}

function collectUnits(root: Element, units: Element[]) {
  for (const child of root.children) {
    if (isExcluded(child) || isHidden(child)) continue;
    if (!hasTranslatableText(child)) continue;
    if (hasOnlyInlineContent(child)) {
      units.push(child);
    } else {
      collectUnits(child, units);
    }
  }
}

function isInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight;
}

/**
 * 原文がいま 1 行に収まっているか。sidebar 項目やボタンのような単行テキストは
 * 訳文を横並び（nbsp 区切り）にし、折り返している段落は改行（<br>）で挿入する
 */
function isSingleLine(el: Element): boolean {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length <= 1) return true;

  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || rects[0].height;
  return bottom - top < lineHeight * 1.5;
}

function runTranslation() {
  const units: Element[] = [];
  collectUnits(document.body, units);

  if (units.length === 0) {
    console.warn("[monica-translate] no translatable units");
    return;
  }

  let segId = 0;
  const segments: Array<{ seg: number; text: string; inViewport: boolean }> = [];
  for (const el of units) {
    // 既に訳文が付いている単位（SPA 遷移で残った sidebar 等）は再送しない
    if (el.querySelector(":scope > .monica-translation")) continue;
    const seg = segId++;
    (el as HTMLElement).dataset.monicaSeg = String(seg);
    segments.push({
      seg,
      text: unitText(el),
      inViewport: isInViewport(el),
    });
  }

  if (segments.length === 0) {
    console.log("[monica-translate] everything already translated");
    return;
  }

  // viewport 内を先頭に並べ替え、streaming で画面から順に埋まるようにする
  segments.sort((a, b) => Number(b.inViewport) - Number(a.inViewport));
  const payload = segments.map(({ seg, text }) => ({ seg, text }));

  console.log(
    `[monica-translate] sending ${payload.length} segments (${segments.filter((s) => s.inViewport).length} in viewport)`,
  );
  chrome.runtime.sendMessage({ type: "translate", segments: payload });

  // listener は 1 回だけ登録する（SPA 遷移後の再実行で重複させない）
  if (w.__monicaTranslateListening) return;
  w.__monicaTranslateListening = true;

  chrome.runtime.onMessage.addListener(
    (message: { type: string; seg?: number; translation?: string; message?: string }) => {
      if (message.type === "translation" && message.seg != null && message.translation) {
        const el = document.querySelector(`[data-monica-seg="${message.seg}"]`);
        if (!el) return;
        if (el.querySelector(":scope > .monica-translation")) return;

        // 原文と同じ要素の子として追記し、スタイルを継承させる（immersive-translate 方式）
        const wrapper = document.createElement("span");
        wrapper.className = "monica-translation notranslate";
        wrapper.setAttribute("lang", "ja");
        wrapper.setAttribute("translate", "no");
        const inner = document.createElement("span");
        inner.textContent = message.translation;
        if (isSingleLine(el)) {
          wrapper.appendChild(document.createTextNode("\u00A0\u00A0"));
        } else {
          inner.style.display = "block";
          inner.style.marginTop = "0.5em";
        }
        wrapper.appendChild(inner);
        el.appendChild(wrapper);
      } else if (message.type === "done") {
        console.log("[monica-translate] done");
      } else if (message.type === "error") {
        console.error(`[monica-translate] error: ${message.message}`);
      }
    },
  );
}

// URL 単位のガード: SPA 遷移後は再クリックで新ページを翻訳できる。
// 同一 URL での連打だけを抑止する
if (w.__monicaTranslateUrl !== location.href) {
  w.__monicaTranslateUrl = location.href;
  runTranslation();
}
