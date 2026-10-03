import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { cleanUp, onCleanup, setup } from "./testing.ts";

afterEach(cleanUp);

function project() {
  const cwd = mkdtempSync(join(tmpdir(), "tania-editor-"));
  onCleanup(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "src"));
  const file = join(cwd, "src", "main.ts");
  writeFileSync(file, "");
  return { cwd, file: realpathSync(file) };
}

test("a printed path resolves to the existing file it names, with or without a line and column", async () => {
  const { client } = setup();
  const { cwd, file } = project();
  const fromHome = `~/${relative(homedir(), file)}`;

  const resolved = await client.editor.resolve({
    cwd,
    candidates: ["src/main.ts", "./src/main.ts:12", "src/main.ts:12:7", file, fromHome, "~"],
  });

  expect(resolved).toEqual([file, file, file, file, file, realpathSync(homedir())]);
});

test("a path that names no file resolves to null", async () => {
  const { client } = setup();
  const { cwd } = project();

  const resolved = await client.editor.resolve({
    cwd,
    candidates: ["src/missing.ts", "src/missing.ts:12", "src/main.ts:12:7:3", "src/main.ts:x", ""],
  });

  expect(resolved).toEqual([null, null, null, null, null]);
});
