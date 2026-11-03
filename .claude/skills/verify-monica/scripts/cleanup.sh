#!/bin/sh
# usage: cleanup.sh <name>
# launch.sh <name> が作った instance と一時の state を消す。証拠の dir は残す。
set -u

name=${1:?usage: cleanup.sh <name>}
repo=$(cd "$(dirname "$0")/../../../.." && pwd -P)
tmp=${TMPDIR%/}
home=$tmp/monica-$name
evidence=$tmp/verify-monica/$name

if [ -f "$evidence/stdin.pid" ]; then
  sp=$(cat "$evidence/stdin.pid")
  case $(ps -o command= -p "$sp" 2>/dev/null) in
    "sleep 2147483647") kill "$sp" && echo "stdin の sleep ($sp) を止めた" ;;
  esac
  rm -f "$evidence/stdin.pid"
fi

i=0
while [ -f "$home/backend.json" ] && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
if [ -f "$home/backend.json" ]; then
  echo "NG Backend（pid $(jq -r .pid "$home/backend.json")）が抜けないので home を残した。その pid に kill -TERM を送ってから流し直す"
  exit 1
fi

is_home() { [ -e "$1/monica.db" ] || [ -e "$1/ptyd.pid" ] || [ -e "$1/backend.json" ]; }

# Task の Bench の一時 directory。名前が monica-<name>-ghq の別の instance の home は残す。
real_home=$(cd "$tmp" && pwd -P)/monica-$name
set -- "$real_home"
for x in ghq origin mode; do
  [ -e "$home-$x" ] || continue
  if is_home "$home-$x"; then
    echo "$home-$x は別の instance の home なので残した"
  else
    set -- "$@" "$real_home-$x"
  fi
done

# claude の記録の dir の名前は / と - を見分けないので、中の cwd がこの instance の下かで見分ける。
owned() {
  dir=$1
  shift
  for root; do
    grep -rqsF "\"cwd\":\"$root/" "$dir" && return 0
    grep -rqsF "\"cwd\":\"$root\"" "$dir" && return 0
  done
  return 1
}
before=$evidence/claude-projects.before
if [ -f "$before" ]; then
  for d in "$HOME"/.claude/projects/*monica-"$name"*; do
    [ -d "$d" ] || continue
    owned "$d" "$@" || continue
    if grep -qxF "$d" "$before"; then
      echo "$d は起動の前からあったので残した"
    else
      rm -rf "$d" && echo "$d を消した"
    fi
  done
  rm -f "$before"
else
  echo "$before が無いので、~/.claude/projects には触れなかった"
fi

shift
for d; do rm -rf "$d" && echo "$d を消した"; done

# Backend が抜けても ptyd と、同じ home の Brave は残る。
if [ -d "$home" ]; then
  (cd "$repo" && bun scripts/dev.ts kill "monica-$name") || rm -rf "$home"
fi

i=0
while pgrep -f "^[^ ]*/monica-ptyd --monica-home $home\$" > /dev/null && [ $i -lt 20 ]; do
  sleep 0.5
  i=$((i + 1))
done
if pgrep -f "^[^ ]*/monica-ptyd --monica-home $home\$" > /dev/null || [ -d "$home" ]; then
  echo "NG 片付け残り: bun run dev:list で monica-$name を見る"
  exit 1
fi
echo "OK 片付いた。証拠は $evidence に残した"
