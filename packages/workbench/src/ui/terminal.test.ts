import { expect, mock, test } from "bun:test";

// Shell は command を別々の thread で走らせるので、先に呼ばれた書き込みが後から届くことがある。
const delivered: string[] = [];
const tauriCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...tauriCore,
  invoke: async (command: string, args: { data?: string }) => {
    if (command !== "terminal_write") return;
    await Bun.sleep(args.data === "slow" ? 20 : 0);
    delivered.push(args.data!);
  },
}));

const { terminalWrite } = await import("./terminal.ts");

test("writes to a Terminal Session reach it in the order they were made", async () => {
  await Promise.all([terminalWrite("ts-1", "slow"), terminalWrite("ts-1", "fast")]);

  expect(delivered).toEqual(["slow", "fast"]);
});
