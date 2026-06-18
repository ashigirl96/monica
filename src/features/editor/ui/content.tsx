import { useEffect, useMemo, useRef, useState } from "react";
import { BubbleMenu } from "@tiptap/react/menus";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { Typography } from "@tiptap/extension-typography";
import {
  DEFAULT_EDITOR_DOCUMENT,
  loadEditorDocument,
  saveEditorDocument,
} from "@/features/editor/persistence";
import { SlashCommand } from "@/features/editor/slash-command";
import { createMinimalVimExtension } from "@/features/editor/vim";
import type { VimMode } from "@/features/editor/vim-logic";
import { cn } from "@/lib/utils";

const SAVE_DEBOUNCE_MS = 500;

type SaveState = "loading" | "saved" | "saving" | "error";

function BubbleButton({
  active,
  children,
  onClick,
}: {
  active?: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => {
        event.preventDefault();
        onClick();
      }}
      className={cn(
        "flex h-7 min-w-7 items-center justify-center rounded px-2 text-xs text-muted-foreground",
        "transition-colors hover:bg-white/[0.1] hover:text-foreground",
        active && "bg-white/[0.14] text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function EditorBubbleMenu({ editor }: { editor: Editor }) {
  const setLink = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const href = window.prompt("URL", previous ?? "");
    if (href === null) return;
    if (href.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run();
  };

  return (
    <BubbleMenu editor={editor} className="editor-bubble-menu">
      <BubbleButton
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        B
      </BubbleButton>
      <BubbleButton
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        I
      </BubbleButton>
      <BubbleButton
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        Code
      </BubbleButton>
      <BubbleButton active={editor.isActive("link")} onClick={setLink}>
        Link
      </BubbleButton>
    </BubbleMenu>
  );
}

function LoadedEditor({ initialDocument }: { initialDocument: JSONContent }) {
  const [mode, setMode] = useState<VimMode>("insert");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDocumentRef = useRef<JSONContent | null>(null);

  const scheduleSave = (document: JSONContent) => {
    pendingDocumentRef.current = document;
    setSaveState("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const pending = pendingDocumentRef.current;
      if (!pending) return;
      saveEditorDocument(pending)
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("error"));
    }, SAVE_DEBOUNCE_MS);
  };

  const extensions = useMemo(
    () => [
      StarterKit.configure({ link: false }),
      Link.configure({
        autolink: true,
        linkOnPaste: true,
        openOnClick: false,
        HTMLAttributes: {
          rel: "noreferrer",
          target: "_blank",
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Typography,
      Placeholder.configure({
        includeChildren: true,
        placeholder: ({ node }) => {
          if (node.type.name === "heading" && node.attrs.level === 1) return "Untitled";
          return "Write, type / for commands";
        },
      }),
      SlashCommand,
      createMinimalVimExtension(setMode),
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    content: initialDocument,
    editorProps: {
      attributes: {
        class: "monica-editor-prose",
        spellcheck: "true",
      },
    },
    onUpdate: ({ editor }) => scheduleSave(editor.getJSON()),
  });

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (pendingDocumentRef.current) void saveEditorDocument(pendingDocumentRef.current);
    };
  }, []);

  if (!editor) return null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[oklch(0.985_0_0)] text-[oklch(0.18_0_0)] dark:bg-[oklch(0.13_0_0)] dark:text-foreground">
      <div className="flex h-9 flex-shrink-0 items-center justify-end gap-2 border-b border-black/[0.06] px-4 text-[11px] text-muted-foreground dark:border-white/[0.08]">
        <span
          className={cn(
            "rounded border px-2 py-0.5 font-mono uppercase tracking-normal",
            mode === "normal"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
              : "border-emerald-500/35 bg-emerald-500/10 text-emerald-300",
          )}
        >
          {mode}
        </span>
        <span>{saveState === "error" ? "Save failed" : saveState}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto max-w-3xl">
          <EditorBubbleMenu editor={editor} />
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}

export default function EditorSpaceContent() {
  const [document, setDocument] = useState<JSONContent | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadEditorDocument()
      .then((loaded) => {
        if (!cancelled) setDocument(loaded);
      })
      .catch(() => {
        if (!cancelled) setDocument(DEFAULT_EDITOR_DOCUMENT);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!document) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading editor
      </div>
    );
  }

  return <LoadedEditor initialDocument={document} />;
}
