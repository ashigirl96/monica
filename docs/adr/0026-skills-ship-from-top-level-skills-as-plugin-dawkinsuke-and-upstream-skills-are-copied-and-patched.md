---
status: accepted
---

# Skill は repo 直下の `skills/` から plugin `dawkinsuke` で配り、Upstream の Skill は写して Skill Patch を当てる

ADR-0006 は、Skill を monica の CLI を呼ぶ手順書だけと見て、`packages/<domain>/skills/` に置き plugin `monica` で配ると決めた。しかし agent に渡している手順書の大半は mattpocock/skills の plugin（mattpocock-skills）で、wayfinder で issue を作ってから `monica task run` で渡す流れは両方をまたぐ。mattpocock-skills の挙動を変えたいとき（retro を model-invoke できるようにする、setup で親 issue に `epic` を付ける）、`~/.claude/PATCH-SKILL.md` に「skill 本文より優先する」と書く今の方法では frontmatter を変えられず、変えた理由も skill から離れた場所に残る。そこで Upstream（mattpocock/skills）の Skill を repo 直下の `skills/` に写し、monica の CLI を操作する Skill と一緒に plugin `dawkinsuke` で配る。写した Skill への変更は Skill Patch として SKILL.md に直接書き、理由を Skill Patch Note に残し、Upstream の新しい版は Upstream Update で反映する。

## Considered Options

- **Skill Patch を当てる Skill だけを写し、mattpocock-skills と併用する**: 同じ bare name の skill が 2 つの plugin にあると、どちらが `/wayfinder` を取るかが決まらない。Upstream の Skill は他の Skill を bare name で呼ぶ（`Call the Skill tool with "grilling"`）ので、写した Skill から呼ばれる側も揺れる。
- **PATCH-SKILL.md で上書きし続ける**: Upstream と衝突しない代わりに、harness が読む frontmatter（`disable-model-invocation`）を変えられない。ある Skill の挙動を知るのに、SKILL.md と PATCH-SKILL.md の 2 か所を読むことになる。
- **monica の CLI を操作する Skill は `packages/<domain>/skills/` に残し、写した Skill だけを `skills/` に置く**: plugin は 1 つで済むが、Skill の置き場所が 2 つになる。
- **plugin を `dawkinsuke` と `monica` の 2 つに分ける**: wayfinder から `monica task run` へ進む流れが 2 つの namespace をまたぐ。
- **写した Skill を日本語に訳す**（`.claude/skills/retro` の形）: Upstream Update のたびに、Upstream の差分を訳文へ手で写すことになる。英語のまま写せば Upstream の差分を機械的に当てられ、ぶつかるのは Skill Patch を当てた行に限られる。

## Consequences

- ADR-0006 のうち、Skill を `packages/<domain>/skills/` に置くこと、plugin 名を `monica` にすること（呼び名 `/monica:<name>`）を、この ADR が置き換える。呼び名は `/dawkinsuke:<name>` になる。Skill が monica に触るときは PATH 上の `monica` を呼ぶだけで env も hook も持たないこと、user scope の directory marketplace で main の checkout から読むこと、開発 skill を `.claude/skills/` に置いて配らないことは変えない。
- 写すのは Upstream の plugin が載せている Skill で、mattpocock/skills では engineering と productivity の bucket にあるもの。写した Skill の本文は英語のまま保つ。
- plugin `dawkinsuke` を enable したら、`mattpocock-skills` は無効にする。
- `~/.claude/PATCH-SKILL.md` にある写した Skill の上書き（grilling、tdd）は Skill Patch に移す。PATCH-SKILL.md には、写していない skill の上書きだけが残る。
- Upstream Update は開発 skill `/update-upstream-skills` が行う。monica の checkout の `skills/` を書き換える手順なので plugin には載せない。Upstream は mattpocock/skills のほかにも増えうる。
- `apps/cli` の Skill の検査テストは、`packages/*/skills` ではなく `skills/` の SKILL.md を集める。
- ADR-0024 の「monica は `/tackle` を配らない」は変えない。`/tackle` は repo ごとに環境が違うので、plugin は repo の setup で `/tackle` を作る手順を配り、`/tackle` そのものは各 repo の `.claude/skills/` に置く。
- Skill Patch Note の形と置き場所、Upstream Update の手順、どの Skill が `/tackle` を作るかは、この決定の外。
