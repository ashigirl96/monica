---
status: accepted
---

# Chat の agent は `.app` に同梱した claude を、この Mac の Claude Code の login で動かす

Chat の agent には、Agent SDK の optionalDependencies にある claude（darwin-arm64 で 236MB）を使う。release では `.app` に同梱し、Shell が env で場所を渡す。ptyd の `MONICA_PTYD_PATH` と同じ形である。dev の Backend は node_modules の中の claude を使う。claude と SDK の版を lockfile で揃えるためで、PATH の `~/.local/bin/claude` を使うと Claude Code の自動更新で SDK とずれる。ずれると、`prewarm()` は CLI が `--await-claim` を知らないときに reject し、2.1.292 では alias `haiku` が Haiku 4.5 に解決された（#257）。認証は、この Mac の Claude Code の login（keychain）をそのまま使い、使用量は plan の上限から引かれる。support の記事は plan の上限で Agent SDK を使えると書いている。規約が禁じるのは他人に claude.ai の login を提供することと、他人の request を plan で流すことで、Chat は自分の Mac で自分だけが使う。

## Considered Options

- **compile した Backend の binary に埋め込む**（`extractFromBunfs`）: binary が 68.6MB から 306.8MB になる。起動のたびに claude を読み出すので、Backend の RSS が常に約 507MB になる。
- **PATH の claude を使う**: `.app` は増えない。代わりに上の版ずれを抱え、Claude Code を入れていない Mac では動かない。
- **API key で動かす**: 使用量は Console の org から引かれ、plan には付かない。代わりに、Team の月ごとの API credit を使うには Team の Owner に Console の org を link してもらう必要がある。秘密の置き場所（keychain か `$MONICA_HOME` の file）も要り、後者はまだ決めていない設定の層を作ることになる。

## Consequences

- `.app` は 236MB 増える。Backend の RSS は増えない。
- `install-app` が、SDK の platform package から claude を `.app` の `Contents/MacOS` に写す。署名は今の `codesign` のまま `--deep` を付けない。付けると、claude の Anthropic の署名が Monica のものに置き換わる。launchd を親に持つ Backend からこの claude を spawn でき、keychain の login で答えることは確かめた（#268）。
- claude の env に `ANTHROPIC_API_KEY` があると、login より優先される（#257）。Backend の env には Monica を起こした shell の env が届きうるので、Chat の agent には認証を替える env を渡さない（ADR-0033）。API key に替えるときは、key の置き場所と一緒に決める。
- claude.ai の login で動かすと claude.ai の connector が載るので、ADR-0033 の切り方が要る。
- Claude Code から logout すると、Chat は認証のエラーで答えられなくなる。
