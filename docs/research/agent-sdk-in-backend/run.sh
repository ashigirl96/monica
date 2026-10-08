#!/bin/bash
# usage: run.sh <login|minimal|nopath> <command...>
#   例: bash login-path.sh > login-path.txt && bash run.sh login "$(command -v bun)" ./probe.ts cold
# Backend の起動に近い env を env -i で作る。login は Backend が loginShellPath() で入れる PATH、minimal は launchd の既定の PATH。
dir=$(cd "$(dirname "$0")" && pwd)
workdir=${R257_WORKDIR:-$dir}
kind=$1
shift
case "$kind" in
  login) path=$(cat "$dir/login-path.txt") ;;
  minimal) path=/usr/bin:/bin:/usr/sbin:/sbin ;;
  nopath) path= ;;
  *) echo "unknown env kind: $kind" >&2; exit 2 ;;
esac
extra=()
[[ -n "${R257_N:-}" ]] && extra+=("R257_N=$R257_N")
[[ -n "${R257_CLAUDE_PATH:-}" ]] && extra+=("R257_CLAUDE_PATH=$R257_CLAUDE_PATH")
[[ -n "${R257_BACKENDLIKE:-}" ]] && extra+=("R257_BACKENDLIKE=$R257_BACKENDLIKE")
[[ -n "${R257_DUMMY_KEY:-}" ]] && extra+=("ANTHROPIC_API_KEY=$R257_DUMMY_KEY")
if [[ "$kind" == nopath ]]; then
  exec env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh TMPDIR="$TMPDIR" \
    R257_DIR="$workdir" "${extra[@]}" "$@"
fi
exec env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh TMPDIR="$TMPDIR" PATH="$path" \
  R257_DIR="$workdir" "${extra[@]}" "$@"
