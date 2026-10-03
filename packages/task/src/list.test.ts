import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { issue, task } from "./schema.ts";
import { cleanUp, setup } from "./testing.ts";

afterEach(() => {
  mock.restore();
  cleanUp();
});

type Books = ReturnType<typeof setup>;

function close({ db }: Books, number: number) {
  const { id } = db.select().from(issue).where(eq(issue.number, number)).get()!;
  db.update(task).set({ closedAt: new Date() }).where(eq(task.issueId, id)).run();
}

test("list shows open Tasks in tracked order with their open Blockers and display state", async () => {
  const books = setup();
  const { github, client } = books;
  github.issue("acme/app#4", { title: "Schema first" });
  github.issue("acme/lib#3", { title: "Upstream fix" });
  github.issue("acme/app#5", { title: "Done already", state: "closed" });
  github.issue("acme/app#12", {
    title: "Ship it",
    blockedBy: ["acme/app#4", "acme/lib#3", "acme/app#5"],
  });
  github.issue("acme/app#2", { title: "Merged, not cleaned up", state: "closed" });
  github.issue("acme/app#1", { title: "Shipped" });
  for (const ref of ["acme/app#12", "acme/app#2", "acme/app#1"]) await client.track({ ref });
  close(books, 1);

  const output = await client.list({});

  expect(output).toEqual({
    tasks: [
      {
        ref: "acme/app#12",
        title: "Ship it",
        issueState: "open",
        blockers: ["acme/app#4", "acme/lib#3"],
        cwd: null,
        displayState: { state: "not_started" },
      },
      {
        ref: "acme/app#2",
        title: "Merged, not cleaned up",
        issueState: "closed",
        blockers: [],
        cwd: null,
        displayState: { state: "issue_closed" },
      },
    ],
    backgroundSyncError: null,
  });
});

test("list with closed shows only the closed Tasks", async () => {
  const books = setup();
  const { github, client } = books;
  github.issue("acme/app#1", { title: "Shipped" });
  github.issue("acme/app#2", { title: "Open" });
  for (const ref of ["acme/app#1", "acme/app#2"]) await client.track({ ref });
  close(books, 1);

  const output = await client.list({ closed: true });

  expect(output.tasks.map((t) => [t.ref, t.displayState.state])).toEqual([
    ["acme/app#1", "closed"],
  ]);
});

function captureInterval() {
  const captured: { tick?: () => void; ms?: number } = {};
  spyOn(globalThis, "setInterval").mockImplementation(((tick: () => void, ms: number) => {
    Object.assign(captured, { tick, ms });
    return 0;
  }) as unknown as typeof setInterval);
  return captured;
}

async function waitFor<T>(read: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
  for (let tries = 0; ; tries++) {
    const value = await read();
    if (done(value)) return value;
    if (tries > 200) throw new Error(`gave up waiting; last value ${JSON.stringify(value)}`);
    await Bun.sleep(5);
  }
}

test("the background sync runs at start and every 5 minutes", async () => {
  const interval = captureInterval();
  const { github, client, task: domain } = setup();
  github.issue("acme/app#1", { title: "One" });
  await client.track({ ref: "acme/app#1" });
  github.requests.length = 0;

  domain.start();
  await waitFor(
    () => github.requests.length,
    (n) => n === 1,
  );
  github.issue("acme/app#1", { title: "One, renamed" });
  interval.tick!();
  const renamed = await waitFor(
    () => client.list({}),
    (output) => output.tasks[0]?.title === "One, renamed",
  );

  expect(interval.ms).toBe(5 * 60_000);
  expect(github.requests).toEqual([
    { repo: "acme/app", numbers: [1] },
    { repo: "acme/app", numbers: [1] },
  ]);
  expect(renamed.backgroundSyncError).toBeNull();
});

test("a failed background sync shows in list until one succeeds", async () => {
  const interval = captureInterval();
  const { github, client, task: domain } = setup();
  github.issue("acme/app#1", { title: "One" });
  await client.track({ ref: "acme/app#1" });
  github.logOut();

  domain.start();
  const failed = await waitFor(
    () => client.list({}),
    (output) => output.backgroundSyncError !== null,
  );
  github.logIn();
  interval.tick!();
  const recovered = await waitFor(
    () => client.list({}),
    (output) => output.backgroundSyncError === null,
  );

  expect(failed.backgroundSyncError).toEqual({
    at: expect.any(Date),
    message: expect.stringContaining("gh auth token"),
  });
  expect(recovered.tasks).toHaveLength(1);
});
