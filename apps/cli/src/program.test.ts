import { expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import type { Client } from "./backend.ts";
import { inMemoryBackend, tania } from "./testing.ts";

function inProcessClient(): Client {
  const { router, context } = inMemoryBackend();
  return createRouterClient(router, { context });
}

test("terminal-session list prints the live sessions as text", async () => {
  const client = inProcessClient();

  const result = await tania(["workbench", "terminal-session", "list"], () => client);

  expect(result).toEqual({
    code: 0,
    stdout: "ID    STATUS   PID  CWD\nts-a  running  42   /work\n",
    stderr: "",
  });
});

test("--format json prints the procedure output as it is", async () => {
  const client = inProcessClient();

  const result = await tania(
    ["workbench", "terminal-session", "list", "--format", "json"],
    () => client,
  );

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    {
      id: "ts-a",
      cwd: "/work",
      shell: "/bin/zsh",
      status: "running",
      pid: 42,
      exitCode: null,
      error: null,
      createdAt: "1970-01-01T00:00:00.000Z",
      endedAt: null,
    },
  ]);
});

test("without a Backend the CLI exits 2", async () => {
  const result = await tania(["workbench", "terminal-session", "list"], () => null);

  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^BACKEND_NOT_RUNNING: [^\n]+\n$/);
});

test("a usage error prints one CODE: message line on stderr and exits 1", async () => {
  const client = inProcessClient();

  const unknownFlag = await tania(
    ["workbench", "terminal-session", "list", "--no-such-flag"],
    () => client,
  );
  const badFormat = await tania(
    ["workbench", "terminal-session", "list", "--format", "xml"],
    () => client,
  );
  const unknownCommand = await tania(["workbench", "nope"], () => client);

  expect(unknownFlag).toEqual({
    code: 1,
    stdout: "",
    stderr: "BAD_REQUEST: unknown option '--no-such-flag'\n",
  });
  expect(badFormat.code).toBe(1);
  expect(badFormat.stderr).toMatch(
    /^BAD_REQUEST: option '--format <format>' argument 'xml' is invalid\.[^\n]*\n$/,
  );
  expect(unknownCommand).toEqual({
    code: 1,
    stdout: "",
    stderr: "BAD_REQUEST: unknown command 'nope'\n",
  });
});
