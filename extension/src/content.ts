// Firefox Translations の InPageTranslation 方式:
// 「本文抽出」はせず、DOM を TreeWalker で降りながら「子が全部テキスト or インライン要素」
// の要素を 1 翻訳単位として収集する。除外は明示的なタグ・属性のみ。
// viewport 内の単位を先に送り、streaming で画面から順に埋まるようにする。

const w = window as unknown as {
  __monicaTranslateListening?: boolean;
  __monicaTranslateInFlight?: boolean;
  innerHeight: number;
};

const EXCLUDED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "pre",
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

/**
 * 連続する「テキストノード + インライン要素」の並び（run）を 1 翻訳単位にする。
 * <p> を使わず裸テキストを <br><br> で区切る古い HTML への対応。
 * run が単一要素ならそのまま、複数ノードなら span.monica-run でラップして単位化する
 */
function flushRun(run: Node[], units: Element[]) {
  const text = run
    .map((n) => n.textContent ?? "")
    .join("")
    .trim();
  if (text.length < MIN_TEXT_LENGTH || !/\p{L}/u.test(text)) return;

  if (run.length === 1 && run[0].nodeType === Node.ELEMENT_NODE) {
    units.push(run[0] as Element);
    return;
  }
  const wrapper = document.createElement("span");
  wrapper.className = "monica-run";
  run[0].parentNode?.insertBefore(wrapper, run[0]);
  for (const node of run) {
    wrapper.appendChild(node);
  }
  units.push(wrapper);
}

function collectUnits(root: Element, units: Element[]) {
  let run: Node[] = [];
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      run.push(node);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;

    // inline タグでも block 子孫を持つなら（例: 全体を包む <span>）コンテナとして扱う
    const isRunBoundary =
      el.tagName === "BR" ||
      !isInlineElement(el) ||
      !hasOnlyInlineContent(el) ||
      isExcluded(el) ||
      el.classList.contains("monica-run");
    if (!isRunBoundary) {
      run.push(el);
      continue;
    }

    flushRun(run, units);
    run = [];

    if (el.tagName === "BR" || isExcluded(el) || isHidden(el)) continue;
    if (!hasTranslatableText(el)) continue;
    if (hasOnlyInlineContent(el)) {
      units.push(el);
    } else {
      collectUnits(el, units);
    }
  }
  flushRun(run, units);
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

// エラーはページ右下の toast で通知する（console だけだとサーバ未起動が見えない）
function showToast(message: string) {
  document.querySelector(".monica-translate-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "monica-translate-toast notranslate";
  toast.setAttribute("translate", "no");
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "2147483647",
    maxWidth: "320px",
    padding: "10px 14px",
    borderRadius: "8px",
    background: "rgba(20, 20, 24, 0.92)",
    color: "#f4f4f5",
    font: "12px/1.5 -apple-system, 'Hiragino Sans', sans-serif",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  document.documentElement.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
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
  w.__monicaTranslateInFlight = true;
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
        // 横並びは「単行 かつ ラベル的に短い」ときだけ。長い 1 行文（広い画面の
        // 段落等）に訳を連結すると折り返しが読みにくいので縦に落とす
        const INLINE_MAX_CHARS = 40;
        if (isSingleLine(el) && unitText(el).length <= INLINE_MAX_CHARS) {
          wrapper.appendChild(document.createTextNode("\u00A0\u00A0"));
        } else {
          inner.style.display = "block";
          inner.style.marginTop = "0.5em";
        }
        wrapper.appendChild(inner);
        el.appendChild(wrapper);
      } else if (message.type === "done") {
        w.__monicaTranslateInFlight = false;
        console.log("[monica-translate] done");
      } else if (message.type === "error") {
        w.__monicaTranslateInFlight = false;
        console.error(`[monica-translate] error: ${message.message}`);
        showToast(message.message ?? "翻訳に失敗しました");
      }
    },
  );
}

// 実行ごとに DOM の現状を見て未翻訳の単位だけを送る。
// 訳済み判定は履歴でなく DOM（.monica-translation の有無）が根拠なので、
// SPA/MPA/lazy load のどれでも再クリックが正しく機能する。
// streaming 中の連打だけは seg ID の振り直しを防ぐため抑止する
if (w.__monicaTranslateInFlight) {
  console.log("[monica-translate] translation in flight — ignoring");
} else {
  runTranslation();
}
