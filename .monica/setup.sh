#!/usr/bin/env bash
set -euo pipefail

# Monica runs this in the worktree before launching the agent. Keep it idempotent.
# Available env: MONICA_TASK_ID, MONICA_TASK_RUN_ID, MONICA_PROJECT_ID (branch / worktree path も渡される)
# 例:
#   corepack enable
#   pnpm install --frozen-lockfile
export MONICA_HOME="$HOME/monica/dev"
direnv allow .

# monica-desktop の build script は binaries/monica-ptyd-<host-triple> を要求する。
# just check/test は ptyd-bin 依存で自動生成されるが、生の cargo check/test でも
# 落ちないよう worktree 作成時点で用意しておく。
just ptyd-bin
