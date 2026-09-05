/// <reference types="bun" />
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Cut the Tauri dependency: github-sync.ts imports from @/commands/github_sync, which pulls in
// the @tauri-apps bindings. The mock lets us drive the command and count calls without a
// Tauri runtime. Must be registered before github-sync.ts is imported.
let forceSyncImpl: () => Promise<void> = () => Promise.resolve();
let forceSyncCalls = 0;
mock.module("@/commands/github_sync", () => ({
  forceSyncGithub: () => {
    forceSyncCalls++;
    return forceSyncImpl();
  },
  onGithubSyncCompleted: () => Promise.resolve(() => {}),
}));

const { createStore } = await import("jotai");
const { forceSyncGithubAtom, githubSyncInFlightAtom } = await import("@/stores/github-sync");

beforeEach(() => {
  forceSyncCalls = 0;
  forceSyncImpl = () => Promise.resolve();
});

describe("forceSyncGithubAtom", () => {
  test("de-dupes a second trigger while a sync is in flight", async () => {
    const store = createStore();
    // Never resolves: keeps the atom in flight for the duration of the test (and avoids
    // arming the success-path backstop timer, which would outlive the test).
    forceSyncImpl = () => new Promise<void>(() => {});

    void store.set(forceSyncGithubAtom);
    expect(store.get(githubSyncInFlightAtom)).toBe(true);

    await store.set(forceSyncGithubAtom);
    expect(forceSyncCalls).toBe(1);
  });

  test("resets in-flight on failure so cmd+r is not wedged", async () => {
    const store = createStore();
    forceSyncImpl = () => Promise.reject(new Error("boom"));

    await store.set(forceSyncGithubAtom);
    expect(store.get(githubSyncInFlightAtom)).toBe(false);
    expect(forceSyncCalls).toBe(1);

    // A retry fires the command again rather than being blocked by a stuck flag.
    forceSyncImpl = () => new Promise<void>(() => {});
    void store.set(forceSyncGithubAtom);
    expect(forceSyncCalls).toBe(2);
    expect(store.get(githubSyncInFlightAtom)).toBe(true);
  });
});
