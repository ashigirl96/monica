#!/bin/sh
# usage: [VERIFY_BACKEND=<…/monica-backend>] launch.sh <name> [VAR=value ...]
# Bash の run_in_background で流す。Backend が抜けるまで戻らない。
# VERIFY_BACKEND を渡すと bun の代わりにその compile 済みの Backend を起こし、ptyd は同じ dir のものを使う。
set -eu

name=${1:?usage: launch.sh <name> [VAR=value ...]}
shift
case $name in *[!a-z0-9-]*) echo "name は小文字・数字・- だけ: $name" >&2; exit 1 ;; esac
for arg; do
  case $arg in [A-Za-z_]*=*) ;; *) echo "name の後ろは VAR=value だけ: $arg" >&2; exit 1 ;; esac
done

repo=$(cd "$(dirname "$0")/../../../.." && pwd -P)
tmp=${TMPDIR%/}
home=$tmp/monica-$name
evidence=$tmp/verify-monica/$name

# sun_path の 104 byte は終わりの NUL を含む。
if [ $(printf %s "$home/ptyd.sock" | wc -c) -gt 103 ]; then
  echo "socket の path が 103 byte を超える。name を短くする: $home/ptyd.sock" >&2
  exit 1
fi
if [ -f "$home/backend.json" ]; then
  echo "$home は使われている。doctor.sh $name で確かめるか、別の name にする" >&2
  exit 1
fi

mkdir -p "$home" "$evidence"
# 同じ name で前に起こした回の [launch exited] を doctor.sh --wait が拾わないよう、log を空にしてから始める。
: > "$evidence/err.log"
: > "$evidence/out.jsonl"
# 前の回の pid は別の process に使い回されていることがある。
rm -f "$evidence/stdin.pid"
trap 'echo "[launch exited]" >> "$evidence/err.log"' EXIT
# 同じ name の home で前に動いた claude の記録を消さないよう、起動の前からある dir を控える。
ls -d "$HOME"/.claude/projects/*monica-"$name"* > "$evidence/claude-projects.before" 2> /dev/null || true

cd "$repo"
if [ -n "${VERIFY_BACKEND:-}" ]; then
  entry=$VERIFY_BACKEND
  script=
  ptyd=$(dirname "$VERIFY_BACKEND")/monica-ptyd
else
  cargo build -q -p monica-ptyd 2>> "$evidence/err.log"
  entry=$(command -v bun)
  script=apps/backend/src/main.ts
  ptyd=$repo/target/debug/monica-ptyd
fi

# monica の Tab や Claude Code の中の MONICA_* と CLAUDECODE を Backend と Job に漏らさない。
path=$(printf %s "$PATH" | tr : '\n' | grep -v -E '\.monica' | paste -sd: -)

# Backend は stdin の EOF で抜けるので、書き口を握る sleep の pid を残す。
sh -c 'echo $$ > "$0"; exec sleep 2147483647' "$evidence/stdin.pid" | {
  status=0
  env -i HOME="$HOME" USER="$USER" SHELL=/bin/zsh TERM=xterm-256color LANG="${LANG:-en_US.UTF-8}" \
    TMPDIR="$TMPDIR" PATH="$path" \
    MONICA_HOME="$home" MONICA_PTYD_PATH="$ptyd" "$@" \
    "$entry" ${script:+"$script"} >> "$evidence/out.jsonl" 2>> "$evidence/err.log" || status=$?
  # 左の sleep は何も書かないので SIGPIPE を受けず、止めないと Backend が落ちても pipeline が終わらない。
  # Backend がすぐ落ちると、左がまだ pid を書いていないことがある。
  i=0
  while [ ! -s "$evidence/stdin.pid" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  kill "$(cat "$evidence/stdin.pid" 2> /dev/null)" 2> /dev/null || true
  exit $status
}
