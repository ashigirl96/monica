#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { commands as taskCommands } from "@tania/task/cli";
import { commands as workbenchCommands } from "@tania/workbench/cli";
import { type Client, connect } from "./backend.ts";

type Command = {
  path: readonly string[];
  description: string;
  run: (argv: string[], deps: { connect: () => Client | null }) => Promise<number>;
};

const home = process.env.TANIA_HOME || join(homedir(), ".tania");
const argv = process.argv.slice(2);
const deps = { connect: () => connect(home) };

// trpc-cli と contract の実体の import だけで compiled の起動が約 30ms 延びるので、手書き command はその前に振り分ける。
const commands: readonly Command[] = [...workbenchCommands, ...taskCommands];
const command = commands.find((c) => c.path.every((part, i) => argv[i] === part));
if (command) process.exit(await command.run(argv.slice(command.path.length), deps));

const { runCli } = await import("./program.ts");
process.exit(
  await runCli(argv, {
    ...deps,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }),
);
