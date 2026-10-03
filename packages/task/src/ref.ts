import { ORPCError } from "@orpc/server";

export type IssueRef = { repo: string; number: number };

const REPO = String.raw`[A-Za-z0-9-]+/[A-Za-z0-9._-]+`;
const NUMBER = String.raw`[1-9]\d*`;
const SHORT = new RegExp(`^(${REPO})#(${NUMBER})$`);
const URL_FORM = new RegExp(`^https://github\\.com/(${REPO})/issues/(${NUMBER})$`);

export function parseRef(input: string): IssueRef {
  const trimmed = input.trim();
  const match =
    SHORT.exec(trimmed) ??
    (trimmed.startsWith("https://") ? URL_FORM.exec(trimmed.replace(/[?#].*$/, "")) : null);
  if (!match) {
    throw new ORPCError("BAD_REQUEST", {
      message: `${JSON.stringify(input)} is not owner/repo#n or https://github.com/owner/repo/issues/n`,
    });
  }
  return { repo: match[1]!, number: Number(match[2]) };
}

export function formatRef({ repo, number }: IssueRef): string {
  return `${repo}#${number}`;
}
