// IME 複製バグ調査用の一時プラグイン。原因特定後に削除する。
// composition / beforeinput / keydown / 生 DOM mutation / 全 transaction を
// 時系列で console と window.__jbImeLog に記録する。
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";

declare global {
  interface Window {
    __jbImeLog: string[];
  }
}

const t0 = performance.now();

function log(...parts: unknown[]): void {
  const line = `[${(performance.now() - t0).toFixed(1)}ms] ${parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")}`;
  window.__jbImeLog ??= [];
  window.__jbImeLog.push(line);
  if (window.__jbImeLog.length > 500) window.__jbImeLog.shift();
  console.log("[jb-ime]", line);
}

function docSummary(doc: PMNode): string {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "blockContainer") return true;
    const id = ((node.attrs.id as string | null) ?? "null").slice(0, 4);
    const content = node.child(0);
    out.push(`${id}:${content.type.name}"${content.textContent}"`);
    return true;
  });
  return out.join(" | ");
}

function describeNode(node: Node | null): string {
  if (!node) return "null";
  if (node.nodeType === Node.TEXT_NODE) return `#text"${node.textContent}"`;
  const el = node as HTMLElement;
  const content = el.dataset?.blockContent ? `[${el.dataset.blockContent}]` : "";
  const id = el.dataset?.blockId ? `#${el.dataset.blockId.slice(0, 4)}` : "";
  return `<${el.nodeName.toLowerCase()}${content}${id} class="${el.className ?? ""}">`;
}

function describeStaticRange(r: StaticRange): string {
  return `${describeNode(r.startContainer)}@${r.startOffset} → ${describeNode(r.endContainer)}@${r.endOffset}`;
}

function domSelection(): string {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return "no-selection";
  return `${describeNode(sel.anchorNode)}@${sel.anchorOffset}..${describeNode(sel.focusNode)}@${sel.focusOffset}`;
}

function logEvent(view: EditorView, name: string, detail: string): false {
  log(
    `ev:${name}`,
    detail,
    `composing=${view.composing}`,
    `sel=${view.state.selection.from}-${view.state.selection.to}`,
    `domSel=${domSelection()}`,
  );
  return false;
}

export function imeDebugPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("journalImeDebug"),
    state: {
      init: (_config, state) => {
        log("init", docSummary(state.doc));
        return null;
      },
      apply(tr, _value, _oldState, newState) {
        if (tr.docChanged) {
          log(
            "tr",
            `steps=${JSON.stringify(tr.steps.map((s) => s.toJSON()))}`,
            `meta.blockOp=${JSON.stringify(tr.getMeta("blockOperation") ?? null)}`,
            `ui=${JSON.stringify(tr.getMeta("uiEvent") ?? null)}`,
            `→ ${docSummary(newState.doc)}`,
          );
        }
        return null;
      },
    },
    props: {
      handleDOMEvents: {
        compositionstart: (view, e) =>
          logEvent(view, "compositionstart", `data="${(e as CompositionEvent).data}"`),
        compositionupdate: (view, e) =>
          logEvent(view, "compositionupdate", `data="${(e as CompositionEvent).data}"`),
        compositionend: (view, e) =>
          logEvent(view, "compositionend", `data="${(e as CompositionEvent).data}"`),
        beforeinput: (view, e) => {
          const be = e as InputEvent;
          const ranges = be.getTargetRanges?.() ?? [];
          return logEvent(
            view,
            "beforeinput",
            `type=${be.inputType} data="${be.data}" ranges=[${ranges.map(describeStaticRange).join(", ")}]`,
          );
        },
        input: (view, e) => logEvent(view, "input", `type=${(e as InputEvent).inputType ?? "?"}`),
        keydown: (view, e) =>
          logEvent(
            view,
            "keydown",
            `key=${e.key} keyCode=${e.keyCode} isComposing=${e.isComposing}`,
          ),
      },
    },
    view(view) {
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          const detail =
            m.type === "characterData"
              ? `"${m.oldValue}" → "${m.target.textContent}"`
              : `added=[${[...m.addedNodes].map(describeNode).join(", ")}] removed=[${[...m.removedNodes].map(describeNode).join(", ")}]`;
          log(`mut:${m.type}`, `target=${describeNode(m.target)}`, detail);
        }
      });
      observer.observe(view.dom, {
        childList: true,
        characterData: true,
        characterDataOldValue: true,
        subtree: true,
      });
      log("observer attached");
      return { destroy: () => observer.disconnect() };
    },
  });
}
