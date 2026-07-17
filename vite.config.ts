import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { PluginOption } from "vite";
import { defineConfig } from "vite";
import { visualizer } from "rollup-plugin-visualizer";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    mode === "analyze" &&
      (visualizer({
        filename: "dist/stats.html",
        gzipSize: true,
        brotliSize: true,
        open: false,
      }) as PluginOption),
  ].filter(Boolean) as PluginOption[],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./desktop"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },

  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/crates/**", "**/target/**"] },
  },

  envPrefix: ["VITE_", "TAURI_ENV_*"],

  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome120" : "es2022",
    minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rolldownOptions: {
      output: {
        minify: {
          compress: {
            treeshake: {
              manualPureFunctions: ["console.debug", "console.info", "console.trace"],
            },
          },
        },
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@xterm/")) return "xterm";
          if (id.includes("@radix-ui/")) return "radix";
          if (id.includes("react-dom")) return "react-dom";
        },
      },
    },
  },
}));
