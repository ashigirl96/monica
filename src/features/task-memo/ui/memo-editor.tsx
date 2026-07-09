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
import { commonmark, emphasisKeymap } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { getMarkdown } from "@milkdown/kit/utils";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { updateTaskMemo } from "@/commands/task";
import { invalidateTaskSummaries } from "@/stores/query-keys";

type MemoEditorProps = {
  taskId: string;
  initialValue: string;
};

const AUTOSAVE_DEBOUNCE_MS = 300;

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
          // Mod-i belongs to the memo toggle (cmd+I closes the modal); move italic aside.
          ctx.set(emphasisKeymap.key, { ToggleEmphasis: { shortcuts: "Mod-Shift-i" } });
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
        .use(listener),
    [],
  );

  useEffect(() => {
    if (loading) return;
    get()?.action((ctx) => ctx.get(editorViewCtx).focus());
  }, [loading, get]);

  // Flush on unmount (Esc / overlay click / cmd+I / space switch all converge here).
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
