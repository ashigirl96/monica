import { installConsoleForwarding } from "./lib/forward-console";

// Deliberately the whole entry module: the app is reached through a dynamic import so that
// forwarding is installed before any of it is evaluated. With static imports, a module that throws
// while being evaluated aborts the entry before its first statement runs, and a release build —
// which has no devtools and no webview log target — would keep no record of the one failure that
// leaves a blank window.
installConsoleForwarding();

import("./bootstrap")
  .then(({ bootstrap }) => bootstrap())
  .catch((e: unknown) => {
    console.error("failed to start the app:", e);
  });
