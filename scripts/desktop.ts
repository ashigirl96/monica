import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { DEFAULT_HOME, devInstance } from "./dev-instance";

const repo = join(import.meta.dir, "..");

// direnv に書かず process の中で決める（ADR-0006）。Shell → Backend → tab の env → CLI と継がれる。
// Shell は別の cwd で起きるので、相対 path は絶対 path にしてから渡す。
process.env.TANIA_HOME = resolve(process.env.TANIA_HOME || DEFAULT_HOME);
process.env.TANIA_BIN = join(repo, "scripts/tania-dev");
mkdirSync(process.env.TANIA_HOME, { recursive: true, mode: 0o700 });
const { identifier, preferredPort } = devInstance(process.env.TANIA_HOME);

function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((settle) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => settle(error.code !== "EADDRINUSE"));
    server.listen(port, host, () => server.close(() => settle(true)));
  });
}

// vite は localhost で listen し、どちらの loopback に bind するかは名前解決の順で決まるので、両方を見る。
async function firstFreePort(from: number): Promise<number> {
  for (let port = from; ; port++) {
    if ((await bindable(port, "127.0.0.1")) && (await bindable(port, "::1"))) return port;
  }
}

await $`cargo build -p tania-ptyd`.cwd(repo);

const port = await firstFreePort(preferredPort);
const devUrl = `http://localhost:${port}`;
// Shell は Backend の env を消さずに起こすので、Backend の CORS まで届く。
process.env.TANIA_DEV_URL = devUrl;
const homeConfig = {
  identifier,
  build: { devUrl, beforeDevCommand: `bun run dev --port ${port}` },
};
await $`bun run tauri dev --config src-tauri/tauri.dev.conf.json --config ${JSON.stringify(homeConfig)}`.cwd(
  join(repo, "apps/desktop"),
);
