/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { DEFAULT_EDITOR_DOCUMENT, parseEditorDocument } from "@/features/editor/persistence";

describe("parseEditorDocument", () => {
  test("passes through a valid Tiptap document", () => {
    const document = { type: "doc", content: [{ type: "paragraph" }] };
    expect(parseEditorDocument(document)).toBe(document);
  });

  test("falls back for corrupt values", () => {
    expect(parseEditorDocument(null)).toEqual(DEFAULT_EDITOR_DOCUMENT);
    expect(parseEditorDocument("{bad")).toEqual(DEFAULT_EDITOR_DOCUMENT);
    expect(parseEditorDocument({ type: "paragraph" })).toEqual(DEFAULT_EDITOR_DOCUMENT);
  });

  test("rejects a non-array content field", () => {
    expect(parseEditorDocument({ type: "doc", content: "nope" })).toEqual(DEFAULT_EDITOR_DOCUMENT);
  });
});
