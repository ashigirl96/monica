import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { migrations } from "../migrations/index.ts";

test("the latest task snapshot holds only the task tables", async () => {
  const meta = join(migrations.folder, "meta");
  const latest = readdirSync(meta)
    .filter((name) => name.endsWith("_snapshot.json"))
    .sort()
    .at(-1)!;
  const snapshot = await Bun.file(join(meta, latest)).json();

  expect(Object.keys(snapshot.tables).sort()).toEqual([
    "bench",
    "issue",
    "issue_blocker",
    "run",
    "task",
  ]);
});
