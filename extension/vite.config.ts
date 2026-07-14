import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 既定 port の正は Rust（monica-settings）。ここに数値を直書きすると Rust 側の
// 変更に extension が追従せずゼロ設定が壊れるので、ビルド時にソースから読む
function defaultTranslatePort(): number {
  const src = readFileSync(resolve(__dirname, "../crates/monica-settings/src/lib.rs"), "utf8");
  const match = src.match(/pub const DEFAULT_TRANSLATE_PORT: u16 = (\d+);/);
  if (!match) {
    throw new Error("DEFAULT_TRANSLATE_PORT not found in crates/monica-settings/src/lib.rs");
  }
  return Number(match[1]);
}

export default defineConfig({
  publicDir: resolve(__dirname, "public"),
  define: {
    // 既定以外の port で使うときは TRANSLATE_PORT=<port> を付けて再ビルドする
    __TRANSLATE_PORT__: JSON.stringify(Number(process.env.TRANSLATE_PORT) || defaultTranslatePort()),
  },
  build: {
    outDir: resolve(__dirname, "../dist-extension"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        format: "es",
      },
    },
    target: "chrome116",
    minify: false,
  },
});
