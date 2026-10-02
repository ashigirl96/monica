---
status: accepted
---

# Tauri は窓と端末の中継だけに絞り、backend は Bun の sidecar で動かす

monica では Task・DB・CLI まで Rust で書いた結果、人間が読めない領域が大半を占めた。tania では Rust に残すのを Tauri の shell 本体、ptyd（PTY daemon）とその中継、terminal protocol の 4 crate だけにし、いずれも Task を知らない固定の配管とする。Task を含むすべての業務ロジックと DB は TypeScript の backend が持ち、desktop はそれを Bun でコンパイルした sidecar として起動して HTTP/oRPC で呼ぶ。

## Considered Options

- **Electron**: main process が hono と DB と ptyd 中継をすべて TS で持てるので言語が 1 つになる。配布サイズが約 200MB になること、ランタイムが Node になって CLI も Node に揃える必要があること、Workbench の Tauri command 経路を書き直すことを理由に見送った。「言語を 1 つにしたい」がこれらより重くなったら再検討する。
- **ブラウザのみ**: cmd+W / cmd+T を握れず multi-window も制御できないので端末 app の殻にはならない。閲覧系の画面には将来使える。

## Consequences

- 言語は 2 つ残るが、Rust 側は読む必要のない配管に限る。Rust にドメインロジックや DB を置かない。
- sidecar の起動・終了・port の受け渡しは Tauri が担う。
- ランタイムは Bun に統一し、DB は `bun:sqlite` で開く。monica のバイナリ最小化方針は Tauri shell にだけ適用し、sidecar には適用しない。
