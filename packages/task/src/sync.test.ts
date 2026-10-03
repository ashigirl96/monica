import { afterEach, expect, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { issue, issueBlocker, task } from "./schema.ts";
import { syncTask } from "./sync.ts";
import { internals } from "./task.ts";
import { cleanUp, setup } from "./testing.ts";

afterEach(cleanUp);

type Books = ReturnType<typeof setup>;

function titles({ db }: Books): Record<string, string> {
  const rows = db.select().from(issue).orderBy(asc(issue.id)).all();
  return Object.fromEntries(rows.map((r) => [`${r.repo}#${r.number}`, r.title]));
}

function blockersOf({ db }: Books, number: number): string[] {
  const blocked = alias(issue, "blocked");
  return db
    .select({ repo: issue.repo, number: issue.number })
    .from(issueBlocker)
    .innerJoin(blocked, eq(blocked.id, issueBlocker.issueId))
    .innerJoin(issue, eq(issue.id, issueBlocker.blockerId))
    .where(eq(blocked.number, number))
    .orderBy(asc(issue.number))
    .all()
    .map((r) => `${r.repo}#${r.number}`);
}

async function failure(promise: Promise<unknown>): Promise<ORPCError<string, unknown>> {
  const error = await promise.catch((e: unknown) => e);
  if (!(error instanceof ORPCError)) throw new Error(`expected an ORPCError, got ${error}`);
  return error;
}

async function track(books: Books, ...refs: string[]) {
  for (const ref of refs) {
    books.github.issue(ref, { title: `Issue ${ref}` });
    await books.client.track({ ref });
  }
  books.github.requests.length = 0;
}

test("sync copies every open Task with one query per repo and replaces the Blockers", async () => {
  const books = setup();
  const { github, client } = books;
  github.issue("acme/app#4", { title: "Schema first" });
  github.issue("acme/app#5", { title: "Migrate" });
  await track(books, "acme/app#1", "acme/app#2", "acme/lib#7");
  github.issue("acme/app#1", { title: "One", blockedBy: ["acme/app#4"] });
  await client.sync({});
  github.issue("acme/app#1", { title: "One", blockedBy: ["acme/app#5"] });
  github.issue("acme/app#2", { title: "Two" });
  github.requests.length = 0;

  const output = await client.sync({});

  expect(output).toEqual({ synced: 3, missing: [] });
  expect(github.requests.sort((a, b) => a.repo.localeCompare(b.repo))).toEqual([
    { repo: "acme/app", numbers: [1, 2] },
    { repo: "acme/lib", numbers: [7] },
  ]);
  expect(blockersOf(books, 1)).toEqual(["acme/app#5"]);
  expect(titles(books)).toMatchObject({ "acme/app#2": "Two", "acme/app#4": "Schema first" });
});

test("sync splits a repo with more than 50 open Tasks into queries of 50", async () => {
  const books = setup();
  const refs = Array.from({ length: 51 }, (_, i) => `acme/app#${i + 1}`);
  await track(books, ...refs);

  const output = await books.client.sync({});

  expect(output.synced).toBe(51);
  expect(books.github.requests.map((r) => r.numbers.length)).toEqual([50, 1]);
});

test("sync writes the repos that answered and names the ones that failed", async () => {
  const books = setup();
  const { github, client } = books;
  await track(books, "acme/app#1", "acme/lib#7");
  github.issue("acme/app#1", { title: "One, renamed" });
  github.issue("acme/lib#7", { title: "Seven, renamed" });
  github.fail("acme/lib");

  const error = await failure(client.sync({}));

  expect(error.code).toBe("BAD_GATEWAY");
  expect(error.message).toContain("acme/lib: GitHub answered 502");
  expect(error.message).not.toContain("acme/app:");
  expect(titles(books)).toEqual({ "acme/app#1": "One, renamed", "acme/lib#7": "Issue acme/lib#7" });
});

test("a repo GitHub cannot resolve fails the sync and keeps its copies", async () => {
  const books = setup();
  const { github, client } = books;
  await track(books, "acme/app#1", "acme/lib#7");
  github.issue("acme/app#1", { title: "One, renamed" });
  github.removeRepo("acme/lib");

  const error = await failure(client.sync({}));

  expect(error.code).toBe("BAD_GATEWAY");
  expect(error.message).toContain(
    "acme/lib: Could not resolve to a Repository with the name 'acme/lib'.",
  );
  expect(titles(books)).toEqual({ "acme/app#1": "One, renamed", "acme/lib#7": "Issue acme/lib#7" });
});

test("an alias GitHub returns null for keeps its copy and shows up as missing", async () => {
  const books = setup();
  const { github, client } = books;
  await track(books, "acme/app#1", "acme/app#2");
  github.remove("acme/app#2");
  github.issue("acme/app#1", { title: "One, renamed" });

  const output = await client.sync({});

  expect(output).toEqual({ synced: 1, missing: ["acme/app#2"] });
  expect(titles(books)).toEqual({ "acme/app#1": "One, renamed", "acme/app#2": "Issue acme/app#2" });
});

test("sync fails when gh auth token fails", async () => {
  const books = setup();
  await track(books, "acme/app#1");
  books.github.logOut();

  const error = await failure(books.client.sync({}));

  expect(error.code).toBe("BAD_GATEWAY");
  expect(error.message).toContain("gh auth token");
  expect(books.github.requests).toEqual([]);
});

test("sync with a ref copies that Task only, even a closed one", async () => {
  const books = setup();
  const { db, github, client } = books;
  await track(books, "acme/app#1", "acme/app#2");
  db.update(task).set({ closedAt: new Date() }).run();
  github.issue("acme/app#2", { title: "Two, renamed" });

  const output = await client.sync({ ref: "acme/app#2" });

  expect(output).toEqual({ synced: 1, missing: [] });
  expect(github.requests).toEqual([{ repo: "acme/app", numbers: [2] }]);
  expect(titles(books)["acme/app#2"]).toBe("Two, renamed");
});

test("sync with a ref that is not tracked is NOT_FOUND", async () => {
  const books = setup();

  const error = await failure(books.client.sync({ ref: "acme/app#1" }));

  expect(error.code).toBe("NOT_FOUND");
});

test("a closed Task is left as it was unless an open Task names it as a Blocker", async () => {
  const books = setup();
  const { db, github, client } = books;
  await track(books, "acme/app#1", "acme/app#2", "acme/app#3");
  db.update(task)
    .set({ closedAt: new Date() })
    .where(eq(task.issueId, db.select().from(issue).where(eq(issue.number, 1)).get()!.id))
    .run();
  db.update(task)
    .set({ closedAt: new Date() })
    .where(eq(task.issueId, db.select().from(issue).where(eq(issue.number, 2)).get()!.id))
    .run();
  github.issue("acme/app#1", { title: "One, renamed", state: "closed" });
  github.issue("acme/app#2", { title: "Two, renamed", state: "closed" });
  github.issue("acme/app#3", { title: "Three", blockedBy: ["acme/app#2"] });

  await client.sync({});

  expect(github.requests).toEqual([{ repo: "acme/app", numbers: [3] }]);
  expect(titles(books)).toMatchObject({
    "acme/app#1": "Issue acme/app#1",
    "acme/app#2": "Two, renamed",
  });
});

test("a sync asked for while the same sync runs waits for the running one", async () => {
  const books = setup();
  await track(books, "acme/app#1");
  const release = books.github.hold();

  const first = books.client.sync({});
  const second = books.client.sync({});
  await Bun.sleep(50);
  release();

  expect(await Promise.all([first, second])).toEqual([
    { synced: 1, missing: [] },
    { synced: 1, missing: [] },
  ]);
  expect(books.github.requests).toHaveLength(1);
});

test("a sync that joins a running one gives up at its own timeout", async () => {
  const books = setup();
  await track(books, "acme/app#1");
  const deps = internals(books.task);
  const ref = { repo: "acme/app", number: 1 };
  const release = books.github.hold();

  const running = syncTask(deps, ref, 30_000);
  const startedAt = Date.now();
  const joined = await syncTask(deps, ref, 50);
  const waited = Date.now() - startedAt;
  release();

  expect(joined).toEqual({ synced: 0, missing: [], failures: ["timed out after 0.05s"] });
  expect(waited).toBeLessThan(1000);
  expect(await running).toEqual({ synced: 1, missing: [], failures: [] });
  expect(books.github.requests).toHaveLength(1);
});

test("sync tells subscribers that the copies changed", async () => {
  const books = setup();
  await track(books, "acme/app#1");
  const controller = new AbortController();
  const changes = books.task.events.subscribe("change", { signal: controller.signal });

  await books.client.sync({});

  expect((await changes.next()).value).toEqual({ type: "synced" });
  controller.abort();
});
