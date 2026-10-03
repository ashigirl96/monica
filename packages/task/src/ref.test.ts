import { expect, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { formatRef, parseRef } from "./ref.ts";

test.each([
  ["owner/repo#12", { repo: "owner/repo", number: 12 }],
  ["Owner-1/re.po_x#7", { repo: "Owner-1/re.po_x", number: 7 }],
  ["https://github.com/owner/repo/issues/12", { repo: "owner/repo", number: 12 }],
  ["https://github.com/owner/repo/issues/12#issuecomment-1", { repo: "owner/repo", number: 12 }],
  ["https://github.com/owner/repo/issues/12?ref=x#top", { repo: "owner/repo", number: 12 }],
  ["  owner/repo#12\n", { repo: "owner/repo", number: 12 }],
])("parses %p", (input, ref) => {
  expect(parseRef(input)).toEqual(ref);
});

test.each([
  "#12",
  "12",
  "owner/repo",
  "owner/repo#0",
  "owner/repo#x",
  "owner#12",
  "https://github.com/owner/repo/pull/12",
  "https://github.com/owner/repo/issues",
  "https://example.com/owner/repo/issues/12",
  "",
])("refuses %p as BAD_REQUEST", (input) => {
  const error = (() => {
    try {
      parseRef(input);
    } catch (thrown) {
      return thrown;
    }
  })();

  expect(error).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
});

test("formats a ref as owner/repo#n", () => {
  expect(formatRef({ repo: "owner/repo", number: 12 })).toBe("owner/repo#12");
});
