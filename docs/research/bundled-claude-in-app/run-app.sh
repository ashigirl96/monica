#!/bin/bash
# usage: run-app.sh <app> <home> <macos|resources> <run id> <steps> [待つ秒数]
# `open -n` で launchd の子として起こし、results.jsonl に done が出るまで待つ。
# `open` は呼んだ shell の env を app に渡すので、env -i で Dock から起こしたときに近い env にしてから呼ぶ。
set -euo pipefail
app=$1
home=$2
placement=$3
run=$4
steps=$5
limit=${6:-300}
mkdir -p "$home"
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh TMPDIR="$TMPDIR" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-}" \
  __CF_USER_TEXT_ENCODING="${__CF_USER_TEXT_ENCODING:-}" \
  /usr/bin/open -n "$app" --args --home "$home" --claude "$placement" -- "$run" "$steps"
for ((t = 0; t < limit; t++)); do
  if grep -q "\"run\":\"$run\".*\"event\":\"done\"" "$home/results.jsonl" 2>/dev/null; then
    echo "done in ${t}s"
    exit 0
  fi
  sleep 1
done
echo "timeout after ${limit}s; shell.jsonl と results.jsonl の pid を見て止める" >&2
exit 1
