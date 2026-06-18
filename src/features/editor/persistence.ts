import { load } from "@tauri-apps/plugin-store";
import type { JSONContent } from "@tiptap/react";

export const EDITOR_STATE_FILE = "editor-state.json";
export const EDITOR_DOCUMENT_KEY = "document";

export const DEFAULT_EDITOR_DOCUMENT: JSONContent = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1 },
    },
    {
      type: "paragraph",
    },
  ],
};

function cloneDocument(document: JSONContent): JSONContent {
  return JSON.parse(JSON.stringify(document)) as JSONContent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseEditorDocument(raw: unknown): JSONContent {
  if (!isRecord(raw)) return cloneDocument(DEFAULT_EDITOR_DOCUMENT);
  if (raw.type !== "doc") return cloneDocument(DEFAULT_EDITOR_DOCUMENT);
  if ("content" in raw && !Array.isArray(raw.content))
    return cloneDocument(DEFAULT_EDITOR_DOCUMENT);
  return raw as JSONContent;
}

export async function loadEditorDocument(): Promise<JSONContent> {
  try {
    const file = await load(EDITOR_STATE_FILE);
    return parseEditorDocument(await file.get(EDITOR_DOCUMENT_KEY));
  } catch {
    return cloneDocument(DEFAULT_EDITOR_DOCUMENT);
  }
}

export async function saveEditorDocument(document: JSONContent): Promise<void> {
  const file = await load(EDITOR_STATE_FILE);
  await file.set(EDITOR_DOCUMENT_KEY, document);
  await file.save();
}
