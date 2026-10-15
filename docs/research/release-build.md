# release の build の大きさと署名

`bun run build` で作った binary の大きさと、`.app` を署名し直したときの結果を測った事実。手順と理由は `scripts/build.ts` と `scripts/install-app.ts` にある。

## binary の大きさ

- compile した binary は 1 つ約 70MB で、Bun の runtime だけで約 60MB ある。Backend と CLI で約 140MB になる。
- Chat を作ったとき（#283、Bun 1.4.2）の Backend の byte 数は、段ごとに次のように増えた。
  - Chat の本文への変換（linkedom と defuddle）: 74,924,658 から 80,604,786（約 5.7MB 増）。
  - PDF の本文（pdfjs-dist の Worker の entrypoint と `cmaps` の `--asset`）: 89,124,978（約 8.5MB 増）。
  - HTML の本文を Worker に移した（`html-worker.ts` の entrypoint）後: 89,191,026。
- どの段でも、compile した Backend の `snapshot` の本文は `bun run` の Backend と同じだった。

## 署名

- `codesign --deep --options runtime` で署名し直すと、entitlements の無い hardened runtime になり、Backend も claude も `SharedArrayBuffer is not defined` で起きなかった（#268）。
- hardened runtime の下で Bun の JIT に要る entitlements は確かめていない。
