/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  buildArtifactKind,
  buildDraftKind,
  dateTimeLocalValueToOccurredAt,
  occurredAtToDateTimeLocalValue,
  projectIdFromKind,
  titleFromKind,
} from "@/features/library/writer-utils";

describe("writer kind helpers", () => {
  test("reads title and project id from intent kinds", () => {
    const kind = { type: "intent", title: "Ship it", project_id: "owner/repo" } as const;
    expect(titleFromKind(kind)).toBe("Ship it");
    expect(projectIdFromKind(kind)).toBe("owner/repo");
  });

  test("buildDraftKind applies the selected project for intents", () => {
    expect(
      buildDraftKind({ type: "intent", title: "Old", project_id: null }, "New", "owner/repo"),
    ).toEqual({ type: "intent", title: "New", project_id: "owner/repo" });
  });

  test("buildArtifactKind applies the selected project and trims saved titles", () => {
    expect(
      buildArtifactKind({ type: "intent", title: "Old", project_id: "old/repo" }, "  New  ", null),
    ).toEqual({ type: "intent", title: "New", project_id: null });
  });
});

describe("writer occurred_at helpers", () => {
  test("converts datetime-local values to stored ISO strings", () => {
    const value = "2026-01-02T03:04";
    expect(dateTimeLocalValueToOccurredAt(value)).toBe(new Date(value).toISOString());
  });

  test("converts stored ISO strings to datetime-local values", () => {
    const occurredAt = "2026-01-02T03:04:05.000Z";
    const date = new Date(occurredAt);
    const expected = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);

    expect(occurredAtToDateTimeLocalValue(occurredAt)).toBe(expected);
  });

  test("treats blank or invalid date values as unset", () => {
    expect(dateTimeLocalValueToOccurredAt("")).toBeNull();
    expect(occurredAtToDateTimeLocalValue(null)).toBe("");
    expect(occurredAtToDateTimeLocalValue("not-a-date")).toBe("");
  });
});
