# monica-infra 固有の注意

`crates/monica-infra/` は SQLite、GitHub、filesystem、process など外部I/Oの具体実装を置く crate。
domain/usecase 側に具体アダプタの都合を漏らさないこと。

## SQLite schema

- SQLite schema の最新形は `src/sqlite/schema.sql` を source of truth とする。
- テーブル追加・カラム追加・index 追加などの schema 変更は、まず `src/sqlite/schema.sql` に反映する。
- 変更後は repo root で `just db-migrate-diff <name>` を実行し、Atlas に `src/sqlite/migrations/*.sql` を生成させる。生成された SQL と `atlas.sum` を確認してコミット対象に含める。
- その後 `just db-validate` を実行して、Atlas が `schema.sql` と migration directory の両方を検証できることを確認する。
- Monica runtime は起動時にチェックイン済み migration SQL を Rust/rusqlite で未適用分だけ適用する。runtime から Atlas CLI は呼ばない。
- schema 変更時は `src/sqlite/migrations.rs` の current schema smoke query も更新し、既存DBが壊れた schema shape を素通りしないようにする。

## SQLite 実装

- `schema.sql` と Rust の row mapping / store 実装の意味をずらさない。
- 既存DBの意味、CLI/Tauri の response shape、既存コマンドの挙動を壊さない。
- コメントは「なぜ」が非自明な場合のみ書く。
