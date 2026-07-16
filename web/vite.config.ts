import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@shared": resolve(__dirname, "../shared"),
    },
  },
  build: {
    outDir: resolve(__dirname, "../dist-web"),
    emptyOutDir: true,
    target: "es2022",
    minify: "oxc",
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://monica.localhost:19281",
        changeOrigin: true,
      },
      "^/explanations/.+/artifact": {
        target: "http://monica.localhost:19281",
        changeOrigin: true,
      },
    },
  },
});
