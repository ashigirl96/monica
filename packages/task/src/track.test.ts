import { afterEach, expect, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import { issue, issueBlocker, task } from "./schema.ts";
import { cleanUp, setup } from "./testing.ts";

afterEach(cleanUp);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
}

function copies(db: ReturnType<typeof setup>["db"]) {
  return db
    .select({
      repo: issue.repo,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: issue.labels,
      parentId: issue.parentId,
    })
    .from(issue)
    .orderBy(asc(issue.id))
    .all();
}

test("track copies the Issue with its parent and Blockers and makes it a Task", async () => {
  const { db, github, client } = setup();
  github.issue("acme/app#10", { title: "Epic", labels: ["epic"] });
  github.issue("acme/lib#3", { title: "Upstream fix", state: "closed" });
  github.issue("acme/app#4", { title: "Schema first" });
  github.issue("acme/app#12", {
    title: "Ship it",
    labels: ["bug", "p1"],
    parent: "acme/app#10",
    blockedBy: ["acme/lib#3", "acme/app#4"],
  });

  const output = await client.track({ ref: "acme/app#12" });

  expect(output).toEqual({
    ref: "acme/app#12",
    title: "Ship it",
    alreadyTracked: false,
    closed: false,
  });
  const rows = copies(db);
  const idOf = (repo: string, number: number) =>
    rows.findIndex((r) => r.repo === repo && r.number === number) + 1;
  expect(rows).toEqual([
    {
      repo: "acme/app",
      number: 12,
      title: "Ship it",
      state: "open",
      labels: ["bug", "p1"],
      parentId: idOf("acme/app", 10),
    },
    { repo: "acme/app", number: 10, title: "Epic", state: "open", labels: [], parentId: null },
    {
      repo: "acme/lib",
      number: 3,
      title: "Upstream fix",
      state: "closed",
      labels: [],
      parentId: null,
    },
    {
      repo: "acme/app",
      number: 4,
      title: "Schema first",
      state: "open",
      labels: [],
      parentId: null,
    },
  ]);
  expect(db.select().from(issueBlocker).all()).toEqual([
    { issueId: idOf("acme/app", 12), blockerId: idOf("acme/lib", 3) },
    { issueId: idOf("acme/app", 12), blockerId: idOf("acme/app", 4) },
  ]);
  expect(db.select({ issueId: task.issueId }).from(task).all()).toEqual([
    { issueId: idOf("acme/app", 12) },
  ]);
});

test("track takes the issue URL and keeps GitHub's spelling of the repo", async () => {
  const { db, github, client } = setup();
  github.issue("Acme/App#12", { title: "Ship it" });

  const output = await client.track({
    ref: "https://github.com/acme/app/issues/12#issuecomment-1",
  });

  expect(output.ref).toBe("Acme/App#12");
  expect(copies(db).map((r) => r.repo)).toEqual(["Acme/App"]);
});

test("tracking a tracked Task syncs it and says it was already tracked", async () => {
  const { github, client } = setup();
  github.issue("acme/app#12", { title: "Ship it" });
  await client.track({ ref: "acme/app#12" });
  github.issue("acme/app#12", { title: "Ship it now" });

  const output = await client.track({ ref: "ACME/app#12" });

  expect(output).toEqual({
    ref: "acme/app#12",
    title: "Ship it now",
    alreadyTracked: true,
    closed: false,
  });
});

test("tracking a closed Task does not reopen it", async () => {
  const { db, github, client } = setup();
  github.issue("acme/app#12", { title: "Ship it" });
  await client.track({ ref: "acme/app#12" });
  db.update(task).set({ closedAt: new Date() }).run();

  const output = await client.track({ ref: "acme/app#12" });

  expect(output).toMatchObject({ alreadyTracked: true, closed: true });
  expect(db.select().from(task).get()?.closedAt).not.toBeNull();
});

test.each([
  ["a bare #n", "#12", "BAD_REQUEST"],
  ["a pull request URL", "https://github.com/acme/app/pull/12", "BAD_REQUEST"],
  ["a pull request number", "acme/app#13", "NOT_FOUND"],
  ["a missing issue", "acme/app#99", "NOT_FOUND"],
  ["a repo GitHub cannot resolve", "acme/gone#1", "NOT_FOUND"],
])("track refuses %s with %s and writes nothing", async (_, ref, code) => {
  const { db, github, client } = setup();
  github.issue("acme/app#12", { title: "Ship it" });

  expect(await codeOf(client.track({ ref }))).toBe(code);
  expect(copies(db)).toEqual([]);
});

test("track fails without writing when gh auth token fails", async () => {
  const { db, github, client } = setup();
  github.issue("acme/app#12", { title: "Ship it" });
  github.logOut();

  const error = await client.track({ ref: "acme/app#12" }).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe("BAD_GATEWAY");
  expect((error as Error).message).toContain("gh auth token");
  expect(copies(db)).toEqual([]);
});

test("track tells the change to subscribers", async () => {
  const { github, client, task: domain } = setup();
  github.issue("acme/app#12", { title: "Ship it" });
  const controller = new AbortController();
  const changes = domain.events.subscribe("change", { signal: controller.signal });

  await client.track({ ref: "acme/app#12" });

  expect((await changes.next()).value).toEqual({ type: "task", ref: "acme/app#12" });
  controller.abort();
});

test("a parent that is itself a Task keeps the labels and parent its own sync wrote", async () => {
  const { db, github, client } = setup();
  github.issue("acme/app#1", { title: "Roadmap" });
  github.issue("acme/app#10", { title: "Epic", labels: ["epic"], parent: "acme/app#1" });
  github.issue("acme/app#12", { title: "Ship it", parent: "acme/app#10" });
  await client.track({ ref: "acme/app#10" });
  github.issue("acme/app#10", { title: "Epic (renamed)", labels: ["epic"], parent: "acme/app#1" });

  await client.track({ ref: "acme/app#12" });

  const epic = db.select().from(issue).where(eq(issue.number, 10)).get()!;
  expect(epic).toMatchObject({ title: "Epic (renamed)", labels: ["epic"] });
  expect(epic.parentId).not.toBeNull();
});

test("a Task in a renamed repo follows the new name, tracked again by either name", async () => {
  const { db, github, client } = setup();
  github.issue("acme/old#1", { title: "One" });
  await client.track({ ref: "acme/old#1" });
  github.renameRepo("acme/old", "acme/new");

  const byNewName = await client.track({ ref: "https://github.com/acme/new/issues/1" });
  const byOldName = await client.track({ ref: "acme/old#1" });

  expect(byNewName).toMatchObject({ ref: "acme/new#1", alreadyTracked: true });
  expect(byOldName).toMatchObject({ ref: "acme/new#1", alreadyTracked: true });
  expect(copies(db).map((r) => `${r.repo}#${r.number}`)).toEqual(["acme/new#1"]);
  expect(db.select().from(task).all()).toHaveLength(1);
});
