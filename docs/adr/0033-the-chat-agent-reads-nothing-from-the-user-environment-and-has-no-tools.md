---
status: accepted
---

# Chat の agent は user の環境を読まず、tool を持たずに起こす

ページの本文は、そのサイトを書いた人なら誰でも書ける入力で、agent への指示を紛れ込ませられる。Agent SDK は options を省くと、user の settings（allow の rule を含む）・CLAUDE.md・hooks・skills を読む。claude.ai の login で動かすと claude.ai の connector（Slack など）も載り、built-in の tool も 27 個持つ（#257）。Chat の agent は答えを文字で返せればよいので、指示が届く先を空にして起こす。

- 読まない: `settingSources: []`、`skills: []`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、`persistSession: false`。connector は `strictMcpConfig: true` と env の `ENABLE_CLAUDEAI_MCP_SERVERS=false` で切る。`mcpServers: {}` では切れない。
- tool: `tools: []`、`disallowedTools: ["mcp__*"]`、`permissionPrompts: "none"`。
- system prompt: 文字列で渡し、Claude Code の preset を置き換える。
- cwd: 空の `$MONICA_HOME/chat`。

## Consequences

- `~/.claude.json` と managed policy は、`settingSources: []` でも読まれる。切るには `CLAUDE_CONFIG_DIR` を移すしかなく、そうすると keychain の login の service 名が変わって ADR-0032 の login が読めなくなるので、切らない。
- tool を足すときは、足す理由と、token の無いブラウザの口から起こしてよい理由（ADR-0028、ADR-0017 の「shell や command に届く procedure を載せない」）を ADR に書く。後の機能（Note への取り込み、Task の track）で書き込む tool を足すときも同じ。
- cwd を `$MONICA_HOME` にしないのは、そこに `backend.json`（token の口の token）と `monica.db` があるため。tool は cwd を作業の場所として扱うので、tool を足したときにこれらが作業の場所に入らないよう、空の directory にしておく。
- tool を持たなくても、回答の markdown の外の画像を side panel が読み込むと、URL に埋めた会話の中身が外へ出る。この経路は「model に渡すページの情報」で決める。
