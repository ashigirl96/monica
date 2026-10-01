# Epic Brief の正本は GitHub の epic issue に置き、Monica は写しを持たない

Epic flow で Orchestrator と Worker が共有する Discovery・Human Action・Merge Gate は、Monica の DB でも repo 内 file でもなく、epic issue 本文（Epic Brief）を唯一の正本とする。チームで使う repo では人間の共同作業者に見える場所が正本でないと運用が二重化すること、Orchestrator を記憶を持たない tick として設計する以上、正本は agent の外に要ること、repo 内 file は Worker の書き込みが未マージ PR ブランチに閉じ込められ他 Worker から見えないこと、が理由。Monica が Brief の写しを持つ案は退け、skill 側で epic issue を読むことを強制する。

## Considered Options

- repo 内 file（`docs/epics/NNN.md`）: PR ブランチ隔離の問題に加え、agent の書き込み先ディレクトリを制限している repo では運用不能。
- Monica DB の新テーブル: SessionStart hook での注入は容易だが、所有者にしか見えず、チームメイトからは不可視。
- GitHub 正 + Monica ミラー: single source of truth を曖昧にするだけで、注入は hook が `gh` で生 body を取る形でも成立するため不要と判断。
