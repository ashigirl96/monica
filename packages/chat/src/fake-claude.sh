#!/bin/sh
# 起こし方は、この file を指す symlink の隣の <symlink>.args に、bun・fake-claude.ts・記録の file・場面の順に 1 行ずつある。
{ IFS= read -r bun; IFS= read -r script; IFS= read -r record; IFS= read -r scenario; } < "$0.args"
exec "$bun" "$script" "$record" "$scenario" "$@"
