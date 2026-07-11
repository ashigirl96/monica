#!/usr/bin/env bash
set -euo pipefail

# Monica runs this in the worktree before launching the agent. Keep it idempotent.
# Available env: MONICA_TASK_ID, MONICA_TASK_RUN_ID, MONICA_PROJECT_ID (branch / worktree path も渡される)
# 例:
#   corepack enable
#   pnpm install --frozen-lockfile
export MONICA_HOME="$HOME/monica/dev"

# worktree ごとに固有の web サーバーポートを割り当てる（並列開発で衝突しない）。
# .envrc に書いて direnv 経由で永続化。MONICA_WEB_PORT は monica-desktop の
# debug ビルドが読む。
if ! grep -q MONICA_WEB_PORT .envrc.local 2>/dev/null; then
    port=$((RANDOM % 10000 + 20000))
    echo "export MONICA_WEB_PORT=$port" >> .envrc.local
    echo "export MONICA_WEB_URL=http://monica.localhost:$port" >> .envrc.local
fi
direnv allow .

# monica-desktop の build script は binaries/monica-ptyd-<host-triple> を要求する。
# just check/test は ptyd-bin 依存で自動生成されるが、生の cargo check/test でも
# 落ちないよう worktree 作成時点で用意しておく。
just ptyd-bin
