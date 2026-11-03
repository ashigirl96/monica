#!/bin/sh
# usage: doctor.sh <name> [--wait]
# 読むだけ。exit 0 = 操作してよい、1 = してはいけない。--wait は 60 秒まで待つ。
set -u

name=${1:?usage: doctor.sh <name> [--wait]}
repo=$(cd "$(dirname "$0")/../../../.." && pwd -P)
tmp=${TMPDIR%/}
home=$tmp/monica-$name
evidence=$tmp/verify-monica/$name

check() {
  [ -d "$home" ] || { echo "NG home が無い: $home"; return 1; }
  [ -f "$home/backend.json" ] || { echo "NG backend.json が無い（起動中か落ちた）: $evidence/err.log を読む"; return 1; }
  pid=$(jq -r .pid "$home/backend.json")
  port=$(jq -r .port "$home/backend.json")
  cmd=$(ps -o command= -p "$pid" 2>/dev/null) || { echo "NG backend.json の pid $pid が居ない"; return 1; }
  case $cmd in
    *apps/backend/src/main.ts*)
      cwd=$(lsof -a -p "$pid" -d cwd -Fn | sed -n 's/^n//p')
      [ "$cwd" = "$repo" ] || { echo "NG Backend はこの checkout の source で動いていない: $cwd"; return 1; }
      build="rev=$(git -C "$repo" rev-parse --short HEAD)$([ -z "$(git -C "$repo" status --porcelain)" ] || echo '+dirty')"
      ;;
    */monica-backend) build="binary=$cmd" ;;
    *) echo "NG pid $pid は Backend ではない: $cmd"; return 1 ;;
  esac
  health=$(curl -sf "http://127.0.0.1:$port/health") || { echo "NG /health が返らない: port $port"; return 1; }
  [ "$(printf %s "$health" | jq -r .pid)" = "$pid" ] || { echo "NG port $port は別の process のもの: $health"; return 1; }
  pgrep -f "^[^ ]*/monica-ptyd --monica-home $home\$" > /dev/null || { echo "NG この home の monica-ptyd が居ない"; return 1; }
  [ -S "$home/ptyd.sock" ] || { echo "NG ptyd.sock が無い"; return 1; }
  MONICA_HOME=$home "$repo/scripts/monica-dev" workbench terminal-session list --format json > /dev/null 2>&1 ||
    { echo "NG CLI が Backend に繋がらない（token か protocol）"; return 1; }
  echo "OK home=$home backend=$pid port=$port $build evidence=$evidence"
}

if [ "${2:-}" = --wait ]; then
  i=0
  until out=$(check); do
    i=$((i + 1))
    # 起動の直後は、launch.sh が前の回の log を空にする前のことがある。
    if [ $i -ge 120 ] || { [ $i -ge 4 ] && grep -q '^\[launch exited\]' "$evidence/err.log" 2>/dev/null; }; then
      echo "$out"
      exit 1
    fi
    sleep 0.5
  done
  echo "$out"
else
  check
fi
