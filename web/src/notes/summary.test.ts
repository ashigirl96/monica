/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { Note, NoteKind } from "@/types.gen";
import { noteLabel } from "./summary";

function note(kind: NoteKind): Note {
  return {
    id: "note-1",
    kind,
    content: { type: "doc", content: [] },
    date: "2026-08-29",
    created_at: "2026-08-29T10:00:00.000Z",
    updated_at: "2026-08-29T10:00:00.000Z",
  };
}

describe("noteLabel", () => {
  test("essay は非空 title を使う", () => {
    const kind: NoteKind = {
      kind: "essay",
      title: "On Rust",
      status: "writing",
      next_status: "finished",
    };
    expect(noteLabel(note(kind), "Untitled")).toBe("On Rust");
  });

  test("essay の無題は fallback", () => {
    const kind: NoteKind = { kind: "essay", title: "", status: "writing", next_status: "finished" };
    expect(noteLabel(note(kind), "Untitled")).toBe("Untitled");
  });

  test("project は非空 title を使い、無題は fallback", () => {
    expect(noteLabel(note({ kind: "project", project_id: "a/b", title: "Spec" }), "a/b")).toBe(
      "Spec",
    );
    expect(noteLabel(note({ kind: "project", project_id: "a/b", title: "" }), "a/b")).toBe("a/b");
  });

  test("daily は title を持たないので常に fallback", () => {
    expect(noteLabel(note({ kind: "daily" }), "Sat 8.29")).toBe("Sat 8.29");
  });
});
