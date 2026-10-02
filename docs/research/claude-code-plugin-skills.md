# Claude Code Plugin で monorepo 内の skill を配布する

## 結論

**決定「skill の正本を `packages/<domain>/skills/<name>/SKILL.md` に置き、Claude Code plugin として他 repo に配布する」は成立する**。以下の条件下：

- **plugin.json の `skills` フィールドは複数ディレクトリを配列で指定でき、repo 内の任意パスを指せる**：`"skills": ["./packages/domain1/skills", "./packages/domain2/skills"]` のように、monorepo の package 内のディレクトリを指定できる。デフォルトの `skills/` に加えて追加される（merge ではなく add）。

- **Private git repo または local path からのインストールは可能**。marketplace を通さず、github owner/repo shorthand か git URL で `/plugin marketplace add` したうえで `/plugin install <plugin>@<marketplace>` でインストール可能。marketplace.json は不要（plugin entry のソースフィールドで個別に指定）。

- **Skill 名は `<plugin-name>:<skill-name>` に自動プリフィックス付け**され、現在の symlink 方式と共存可能。衝突しない。

- **Plugin 内に hooks, commands, agents, MCP servers を同梱可能**。将来 `tania hook claude` を配布する場合も plugin フォーマット内に収納できる。

- **Plugin 更新は manifest の `version` フィールドでピンニング。Marketplace でこのプラグインの auto-update を制御する仕組みあり**。再インストール不要。

- **Repo 直下 `.claude/skills` symlink 方式との比較：Plugin 方式は package ownership を宣言でき、バージョン管理と distribute 機構が完全。symlink は手動メンテナンス、リンク切れのリスク**。本決定の方が運用が簡潔。

## 根拠

### Plugin.json `skills` フィールド

https://code.claude.com/docs/en/plugins/manifest-reference.md — Field Table

`skills` フィールドは path または path 配列。デフォルト `skills/` スキャンに加えて（**"Adds to the default"**）追加ディレクトリをロードする：

```json
{
  "name": "tania-skills",
  "skills": [
    "./packages/orchestration/skills",
    "./packages/data/skills",
    "./packages/platform/skills"
  ]
}
```

各ディレクトリ下は `<name>/SKILL.md` 形式。複数ディレクトリ指定時も同じレイアウト。

参考：mattpocock-skills plugin の plugin.json では 25 個の skill を配列で指定している。
https://code.claude.com/docs/en/plugins/components.md#skills — "You can also place skills outside the default `skills/` directory"

### Local path または Git repo からのインストール

https://code.claude.com/docs/en/plugins/install.md#add-a-marketplace

`/plugin marketplace add <source>` で以下が受け入れられる：

- GitHub repository: `owner/repo` / `owner/repo#ref`
- Git repository: full clone URL with `#ref` for branch/tag
- Local directory: `./path` または `../path` で `.claude-plugin/marketplace.json` の親ディレクトリ
- Hosted marketplace.json: `https://` URL

Marketplace.json そのものは不要。プラグイン source として plugin entry で指定可能。例：

```json
{
  "name": "tania-marketplace",
  "owner": { "name": "ashigirl96" },
  "plugins": [
    {
      "name": "tania-skills",
      "source": "github",
      "repo": "ashigirl96/tania",
      "ref": "main"
    }
  ]
}
```

参考：https://code.claude.com/docs/en/plugins/marketplace-reference.md#plugin-sources — github / url / git-subdir sources すべて supported。

### Skill 名空間プリフィックス

https://code.claude.com/docs/en/plugins/manifest-reference.md#name — "Every component is namespaced under it"

Plugin は `"name"` によって namespace。skill `review` は `/deploy-tools:review` で実行される。衝突回避機構は：

- Plugin 内で skill directory 名で自動 namespace。`./packages/domain1/skills/review/SKILL.md` は `/tania:review` にはならず、domain パスは ignored。Directory 名 `review` のみが使われる。
- 衝突は **plugin 名の prefix で回避** → `tania-orchestration:deploy`, `tania-data:migrate` 等のように plugin 分割時は明確に分岐。

現在の symlink (attach-task, track-issue) と共存：symlink は skills-dir source ロード、plugin は plugin source ロード。両者は独立した loading 機構。

参考：https://code.claude.com/docs/en/plugins/loading#find-where-a-plugin-came-from — each plugin has ID `name@marketplace`。

### Plugin 内の Hooks / Commands 同梱

https://code.claude.com/docs/en/plugins/components.md

Plugin は以下をすべて同梱可能：

- **Skills**: `skills/` directory
- **Agents**: `agents/` directory
- **Hooks**: `hooks/hooks.json` + scripts
- **MPC servers**: `.mcp.json`
- **Commands**: `commands/` directory
- **Output styles, themes, monitors** etc.

将来 `tania hook claude` feature が必要なら：

```json
{
  "name": "tania-skills",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/scripts/my-hook.sh\""
          }
        ]
      }
    ]
  }
}
```

参考：https://code.claude.com/docs/en/plugins/components.md#hooks

### Plugin 更新反映

https://code.claude.com/docs/en/plugins/loading#versions-and-updates

Plugin manifest で `"version": "1.0.0"` を set。User はこのバージョンに pinned。

Update: manifest の `version` を上げると、user の次回 session で fetch される。Marketplace の auto-update setting で制御。

参考：https://code.claude.com/docs/en/plugins/install.md#keep-plugins-updated

再インストール不要。Plugin reload (session 内の `/reload-plugins`) で反映。

### Repo 直下 `.claude/skills` symlink vs Plugin 方式

現状 ~/.claude/skills：

```
attach-task -> /Users/1e0nhard96/.ghq/src/github.com/ashigirl96/monica/.claude/skills/attach-task
track-issue -> /Users/1e0nhard96/.ghq/src/github.com/ashigirl96/monica/.claude/skills/track-issue
epic-worker -> /Users/1e0nhard96/.ghq/src/github.com/ashigirl96/monica/.claude/skills/epic-worker
create-pr -> /Users/1e0nhard96/.ghq/src/github.com/ashigirl96/monica/.claude/skills/create-pr
```

**Symlink 方式の課題**：
- Manual setup （each dev 手動で symlink）
- Link breakage risk （repo move / delete）
- Version management なし
- Other repo に distribute 困難

**Plugin 方式の利点**：
- Package ownership declaration（`packages/<domain>/skills/` で domain 明示）
- Version pinning + auto-update in manifest
- Git source で distribute 可能
- Skill 更新時 marketplace refresh で全環境に propagate
- Hooks / agents との co-location で domain-specific toolchain 実現可能

## 現状の ~/.claude/skills

以下の 3 つの broken symlink と実ディレクトリ混在：

```
lrwxr-xr-x  attach-task -> /Users/1e0nhard96/.ghq/src/github.com/ashigirl96/monica/.claude/skills/attach-task
lrwxr-xr-x  track-issue -> /Users/1e0nhard96/.ghq/src/github.com/ashigirl96/monica/.claude/skills/track-issue
lrwxr-xr-x  epic-worker -> /Users/1e0nhard96/.ghq/src/github.com/ashigirl96/monica/.claude/skills/epic-worker
drwxr-xr-x  cc-wiki （実ディレクトリ）
drwxr-xr-x  explain-diff-html （実ディレクトリ）
drwxr-xr-x  test-audit （実ディレクトリ）
drwxr-xr-x  synced （実ディレクトリ）
```

Broken links：`.claude/skills/attach-task`, track-issue, epic-worker は全て monica repository の symlink。

## 推奨する構成

### Monorepo Layout

```
tania/
├── .claude/
│   ├── settings.json
│   └── skills/
├── .claude-plugin/
│   └── plugin.json
├── packages/
│   ├── orchestration/
│   │   └── skills/
│   │       ├── attach-task/
│   │       │   └── SKILL.md
│   │       └── track-issue/
│   │           └── SKILL.md
│   ├── data/
│   │   └── skills/
│   │       ├── query/
│   │       │   └── SKILL.md
│   │       └── migrate/
│   │           └── SKILL.md
│   └── platform/
│       └── skills/
│           └── deploy/
│               └── SKILL.md
```

### plugin.json

```json
{
  "name": "tania-skills",
  "version": "0.1.0",
  "description": "tania domain skills: orchestration, data, platform",
  "author": {
    "name": "ashigirl96"
  },
  "homepage": "https://github.com/ashigirl96/tania",
  "repository": "https://github.com/ashigirl96/tania",
  "skills": [
    "./packages/orchestration/skills",
    "./packages/data/skills",
    "./packages/platform/skills"
  ]
}
```

### Distribution

他 repo で使用：

```bash
/plugin marketplace add ashigirl96/tania
/plugin install tania-skills@ashigirl96/tania
```

または settings.json に記述：

```json
{
  "extraKnownMarketplaces": {
    "tania": {
      "source": {
        "source": "github",
        "repo": "ashigirl96/tania"
      }
    }
  },
  "enabledPlugins": ["tania-skills@tania"]
}
```

## 制約と注意

1. **Skill path constraint**：plugin.json `skills` は `./` で始まる必要がある（`"."` は例外）。相対パスはプラグインルートから解決。

2. **Namespace collision**：同じ skill directory name を複数 package に置くと、後ろのものが前のものを overwrite（same namespace）。これを避けるには domain suffix: `attach-task-orchestration`, `attach-task-data` 等で分離、または package-scoped plugin に分割。

3. **Skill co-location constraints**：`<name>/SKILL.md` 内で `${CLAUDE_PLUGIN_ROOT}` を参照可能（supporting files へのパス）。Monorepo 内他 package への参照は不可（plugin scope 外）。必要なら shared library の symlink を `.claude-plugin/` peer で manage するか、MCP server として extract。

4. **Version pinning**：manifest `version` に lock されるため、skill 変更時は tania repo の version bump が必須。過度な granular versioning を避けるため、skill release cycle を domain 単位で aggregate 推奨。

5. **Other repo への distribute：**tania plugin を GitHub から install するため、tania repo が public or accessible require。Private repo の場合は SSH credentials setup or `--config` で token pass 要（https://code.claude.com/docs/en/plugins/install.md）。

## 未確認

1. Plugin 内複数 skill の individual version control（skill ごとに version tag）は未確認。Plugin 全体で single version。

2. Skill が MCP server tool を使う場合、plugin scope 制限で動作するか実装で要検証。

3. Monorepo 内複数 domain のそれぞれ個別 plugin として distribute する場合の名前衝突規則の詳細。

4. `.claude/skills/` symlink と plugin ロード時の優先順位（同じ skill name を両方で定義した場合）。
