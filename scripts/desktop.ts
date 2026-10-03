import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const repo = join(import.meta.dir, "..");

// direnv に書かず process の中で決める（ADR-0006）。Shell → Backend → tab の env → CLI と継がれる。
process.env.TANIA_HOME ||= join(homedir(), ".tania-dev");
process.env.TANIA_BIN = join(repo, "scripts/tania-dev");

await $`cargo build -p tania-ptyd`.cwd(repo);
await $`bun run tauri dev --config src-tauri/tauri.dev.conf.json`.cwd(join(repo, "apps/desktop"));
