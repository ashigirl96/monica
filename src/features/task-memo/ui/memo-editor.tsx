import { useEffect, useRef } from "react";
import { getDefaultStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
} from "@milkdown/kit/core";
import { bulletListSchema, commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { Plugin } from "@milkdown/kit/prose/state";
import { findWrapping } from "@milkdown/kit/prose/transform";
import { $inputRule, $prose, getMarkdown } from "@milkdown/kit/utils";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { updateTaskMemo } from "@/commands/task";
import { invalidateTaskSummaries } from "@/stores/query-keys";

type MemoEditorProps = {
  taskId: string;
  initialValue: string;
};

const AUTOSAVE_DEBOUNCE_MS = 300;

// GFM's task list only carries `checked` as a li[data-checked] attribute — the preset
// ships no checkbox UI. The glyph is drawn by CSS (`.memo-editor li[data-checked]::before`)
// and this plugin toggles the attribute when the gutter (the li itself, not its text
// children) is clicked.
const taskCheckboxToggle = $prose(
  () =>
    new Plugin({
      props: {
        handleClick: (view, _pos, event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement) || target.tagName !== "LI") return false;
          if (target.dataset.checked === undefined) return false;
          const pos = view.posAtDOM(target, 0) - 1;
          const node = view.state.doc.nodeAt(pos);
          if (!node || typeof node.attrs.checked !== "boolean") return false;
          view.dispatch(view.state.tr.setNodeAttribute(pos, "checked", !node.attrs.checked));
          return true;
        },
      },
    }),
);

// Notion-style shortcut: `[ ] ` / `[x] ` at the start of a plain paragraph becomes a task
// item. GFM's own rule only fires inside an existing list item (after typing `- ` first).
const taskAtParagraphStart = $inputRule(
  (ctx) =>
    new InputRule(/^\[(?<checked>\s|x)\]\s$/, (state, match, start, end) => {
      const $start = state.doc.resolve(start);
      for (let depth = $start.depth; depth > 0; depth--) {
        if ($start.node(depth).type.name === "list_item") return null;
      }
      const tr = state.tr.delete(start, end);
      const range = tr.doc.resolve(start).blockRange();
      if (!range) return null;
      const wrapping = findWrapping(range, bulletListSchema.type(ctx));
      if (!wrapping) return null;
      tr.wrap(range, wrapping);
      // the wrap puts bullet_list at range.start, so its list_item sits one position in
      return tr.setNodeMarkup(range.start + 1, undefined, {
        checked: match.groups?.checked === "x",
      });
    }),
);

function MemoEditorInner({ taskId, initialValue }: MemoEditorProps) {
  const dirtyRef = useRef<string | null>(null);
  const savedRef = useRef(initialValue);
  const timerRef = useRef(0);

  const save = async (md: string) => {
    if (md === savedRef.current) return;
    try {
      await updateTaskMemo(taskId, md);
      savedRef.current = md;
    } catch {
      // Keep the dirty value; the next debounce tick or the unmount flush retries.
    }
  };

  const { get, loading } = useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, initialValue);
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            attributes: { class: "notebook-md memo-editor", spellcheck: "false" },
          }));
          ctx.get(listenerCtx).markdownUpdated((_ctx, md) => {
            dirtyRef.current = md;
            clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => {
              if (dirtyRef.current !== null) void save(dirtyRef.current);
            }, AUTOSAVE_DEBOUNCE_MS);
          });
        })
        .use(commonmark)
        .use(gfm)
        .use(listener)
        .use(taskCheckboxToggle)
        .use(taskAtParagraphStart),
    [],
  );

  useEffect(() => {
    if (loading) return;
    get()?.action((ctx) => ctx.get(editorViewCtx).focus());
  }, [loading, get]);

  // Flush on unmount (Esc / overlay click / alt+I / space switch all converge here).
  // The listener debounces internally (~200ms), so the last edits may not have reached
  // dirtyRef yet — read the live document synchronously instead of trusting it.
  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
      let md = dirtyRef.current;
      try {
        md = get()?.action(getMarkdown()) ?? md;
      } catch {
        // Editor already destroyed; fall back to the last listener snapshot.
      }
      const flush =
        md !== null && md !== savedRef.current ? updateTaskMemo(taskId, md) : Promise.resolve();
      void flush
        .catch(() => {})
        .finally(() => {
          if (md === initialValue && savedRef.current === initialValue) return;
          void invalidateTaskSummaries(getDefaultStore().get(queryClientAtom));
        });
    };
  }, []);

  return <Milkdown />;
}

export default function MemoEditor(props: MemoEditorProps) {
  return (
    <MilkdownProvider>
      <MemoEditorInner {...props} />
    </MilkdownProvider>
  );
}
