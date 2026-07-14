import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  publicDir: resolve(__dirname, "public"),
  define: {
    // bridge 側の設定（settings.json の port）と揃える。既定以外で使うときは
    // TRANSLATE_PORT=<port> を付けて再ビルドする
    __TRANSLATE_PORT__: JSON.stringify(Number(process.env.TRANSLATE_PORT) || 43110),
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
