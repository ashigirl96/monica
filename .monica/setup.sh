#!/bin/sh
set -eu
bun install

# CLAUDE.local.md は追跡しないので、本体の checkout のものを symlink で見せ、教訓を 1 か所に残す。
main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
if [ -f "$main/CLAUDE.local.md" ] && [ "$main" != "$(pwd -P)" ]; then
  ln -sfn "$main/CLAUDE.local.md" CLAUDE.local.md
fi
