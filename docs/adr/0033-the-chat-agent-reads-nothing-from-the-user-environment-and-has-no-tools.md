---
status: accepted
---

# Chat の agent は user の環境を読まず、tool を持たずに起こす

ページの本文は、そのサイトを書いた人なら誰でも書ける入力で、agent への指示を紛れ込ませられる。Agent SDK は options を省くと、user の settings（allow の rule を含む）・CLAUDE.md・hooks・skills を読む。claude.ai の login で動かすと claude.ai の connector（Slack など）も載り、built-in の tool も 27 個持つ（#257）。user の他の Claude Code の session から届く message も受け、受けると自分で turn を起こす（#271）。Chat の agent は答えを文字で返せればよいので、指示が届く先を空にして起こす。

- 読まない: `settingSources: []`、`skills: []`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、`persistSession: false`。connector は `strictMcpConfig: true` と env の `ENABLE_CLAUDEAI_MCP_SERVERS=false` で切る。`mcpServers: {}` では切れない。
- tool: `tools: []`、`disallowedTools: ["mcp__*"]`、`permissionPrompts: "none"`。
- 他の session の message: `settings` に `{ crossSessionInbound: "refuse" }` を渡し、env に `CLAUDE_CODE_RESTRICTED=1` を足す。
- system prompt: 文字列で渡し、Claude Code の preset を置き換える。
- cwd: 空の `$MONICA_HOME/chat`。
- env: Backend の env を継がない。Backend の env からは `USER` と `HOME` だけを写し、上の 3 つと `DISABLE_AUTOUPDATER=1`・`CLAUDE_CODE_MAX_RETRIES=4` を足す。SDK の `env` は `process.env` に重ならず、丸ごと置き換わる。

## Consequences

- `~/.claude.json` と managed policy は、`settingSources: []` でも読まれる。切るには `CLAUDE_CONFIG_DIR` を移すしかなく、そうすると keychain の login の service 名が変わって ADR-0032 の login が読めなくなるので、切らない。
- tool を足すときは、足す理由と、token の無いブラウザの口から起こしてよい理由（ADR-0028、ADR-0017 の「shell や command に届く procedure を載せない」）を ADR に書く。後の機能（Note への取り込み、Task の track）で書き込む tool を足すときも同じ。
- cwd を `$MONICA_HOME` にしないのは、そこに `backend.json`（token の口の token）と `monica.db` があるため。tool は cwd を作業の場所として扱うので、tool を足したときにこれらが作業の場所に入らないよう、空の directory にしておく。
- tool を持たなくても、回答の markdown の外の画像を side panel が読み込むと、URL に埋めた会話の中身が外へ出る。この経路は「model に渡すページの情報」で決める。
- env を通す key だけで組むのは、Backend の env に何が入るかを Monica が決められないため。Monica を terminal や Tab の agent から `open` で起こすと、その shell の env が Shell を経て Backend まで届く。dev の Shell は Backend の env を消さずに起こす（#268）。その env には、親の claude が自分の env に書いた `~/.claude/settings.json` の `env` が入っているので、`settingSources: []` にしても user の settings が届く。effort の option より強い `CLAUDE_CODE_EFFORT_LEVEL` や、`haiku` の解決先を変える `ANTHROPIC_DEFAULT_HAIKU_MODEL` もある。落とす key を並べる形にすると、Claude Code が版ごとに足す env を追いかけ続けることになる（#270）。
- 認証と接続先を替える env（`ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`・`CLAUDE_CODE_OAUTH_TOKEN`・`ANTHROPIC_BASE_URL`・`CLAUDE_CODE_USE_BEDROCK` など）も届かない。Monica を起こした shell の env しだいで、plan の login から別の課金に黙って替わることはない。
- claude は keychain の account 名を `USER` から決めるので、`USER` が無いと login を読めない。`HOME` と `PATH` は無くても答える。`HOME` を写すのは、テストで home を分けられるようにするため。proxy と CA の env は通さないので、proxy の内側で使うようになったら足す。
- `DISABLE_AUTOUPDATER=1` は、同梱した claude が自分を更新しないようにするため。SDK から起こした claude が更新を走らせるかは確かめていないが、走れば ADR-0032 の「claude と SDK の版を lockfile で揃える」が崩れる。
- `CLAUDE_CODE_MAX_RETRIES=4` は、API の一時的な失敗（529・500・network に届かない）で答えを待たせる時間を約 8 秒にするため。既定の 10 回では、CLI が `api_retry` だけを流しながら約 3 分再試行する。plan の上限の 429 は回数によらず再試行しない（#269）。この env は CLI のコードで読んだだけなので、効くかは実装で確かめる。
- 他の session の message を断るのは、ADR-0028 が守らないとした同じ Mac の process から守るためではない。普通の送り手は user 自身の Claude Code の session で、送られると答えが壊れるため。SDK から起こした claude は inbox の socket を開き、user の他の session の `ListAgents` に普通の session と見分けのつかない行で出る。そこへ `SendMessage` が届くと、spare は `query()` を呼ばれる前にその場で turn を起こし、SDK はその turn の result を質問の答えより先に流す。次の質問も、その turn を履歴に持ったまま答える。docs の「非対話の session は保留して 5 分で捨てる」は、送り手が bypass のときにしか当たらない（#271）。
- refuse と restricted を重ねるのは、片方では足りないため。`crossSessionInbound` は docs が約束する口で、`settingSources: []` でも flag の settings として読まれるが、socket は開いたままで `ListAgents` に出続ける。restricted は socket を開かないので一覧から消えるが、この効果は docs に無く、claude の実装で確かめただけ。版が上がって restricted が socket を開くようになっても、message は refuse で断られ、一覧に出るだけになる。restricted のほかの効果（command やコードを走らせる tool と WebFetch を外す、managed と `--settings` のほかの settings を読まない）は、上の options と重なるだけでぶつからない。bare mode（`CLAUDE_CODE_SIMPLE=1`）も socket を開かないが、keychain の login も読まなくなるので使わない。
