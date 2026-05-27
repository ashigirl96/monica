#!/usr/bin/env bash
set -euo pipefail

# Monica runs this in the worktree before launching the agent. Keep it idempotent.
# Available env: MONICA_ID, MONICA_RUN_ID, MONICA_PROJECT_ID (branch / worktree path も渡される)
# 例:
#   corepack enable
#   pnpm install --frozen-lockfile
direnv allow .
