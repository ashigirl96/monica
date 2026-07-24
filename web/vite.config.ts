import { readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type ProxyOptions } from "vite";

const PROD_TARGET = "http://monica.localhost:19280";
// monica-desktop の debug ビルドが「実際に bind した port + 自身の PID」を書く rendezvous。
const portFile = resolve(__dirname, "../target/monica-web-port");

// SIGINT/SIGTERM 終了では backend がファイルを消せないため、残留ファイルは PID の
// 生存確認で判定する。疎通チェックのようなヒューリスティックにしないのは、生きている
// dev backend を silent に prod へ落とす誤判定を許さないため。
function devBackendPort(): string | null {
  let content: string;
  try {
    content = readFileSync(portFile, "utf8");
  } catch {
    return null;
  }
  const [port, pid] = content.split("\n");
  if (!/^\d+$/.test(port) || !/^\d+$/.test(pid ?? "")) return null;
  try {
    process.kill(Number(pid), 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") {
      console.log(`[proxy] stale port file (pid ${pid} gone) → prod :19280`);
      unlinkIfPidUnchanged(pid);
      return null;
    }
    // EPERM 等はプロセス生存とみなす
  }
  return port;
}

// stale 判定と unlink の間に新 backend が書き込むと生きたファイルを消してしまうため、
// 直前に再 read して PID が同一のときだけ消す。
function unlinkIfPidUnchanged(stalePid: string) {
  try {
    const [, pid] = readFileSync(portFile, "utf8").split("\n");
    if (pid === stalePid) unlinkSync(portFile);
  } catch {
    // 既に消えている / 読めない場合は何もしない
  }
}

let lastTarget = "";
function resolveTarget(): string {
  const port = devBackendPort();
  const target = port ? `http://monica.localhost:${port}` : PROD_TARGET;
  if (target !== lastTarget) {
    lastTarget = target;
    console.log(port ? `[proxy] → dev backend :${port}` : "[proxy] → prod :19280");
  }
  return target;
}

// Vite はリクエスト毎に bypass を await してから proxy.web(req, res, {}) を呼び、
// バンドルされた http-proxy-3 は createProxyServer に渡したこのオブジェクトを毎回
// {...options} で読み直す。そのため bypass で target を書き換えるとリクエスト単位で
// 反映される。bypass の第3引数はシャローコピーなので closure の opts を書き換えること。
function dynamicTarget(): ProxyOptions {
  const opts: ProxyOptions = {
    // 初期値は最初のリクエストの bypass が必ず上書きするので実際には使われない。
    // resolveTarget() をここで呼ばないのは、config 読み込み（vite build 含む）に
    // fs 読みとログの副作用を持ち込まないため。
    target: PROD_TARGET,
    changeOrigin: true,
    bypass() {
      opts.target = resolveTarget();
    },
  };
  return opts;
}

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
      "/api": dynamicTarget(),
      "^/explanations/.+/artifact": dynamicTarget(),
    },
  },
});
