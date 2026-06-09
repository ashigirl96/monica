# monica-infra

## SQLite テーブル命名規約

- 中間テーブル（junction table）は Prisma の implicit many-to-many 命名に倣い `_ModelAToModelB` とする（例: `_TaskToRunspace`）。アルファベット順。
