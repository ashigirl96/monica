#!/bin/bash
# Backend の loginShellPath() と同じ形で、launchd 相当の最小 env から login shell の PATH を取る。
cd "$HOME" || exit 1
out=$(env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh TMPDIR="$TMPDIR" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin DISABLE_AUTO_UPDATE=true \
  /bin/zsh -ilc 'printf "%s" "@@"; printf "%s" "$PATH"; printf "%s" "@@"' </dev/null 2>/dev/null)
path=${out#*@@}
path=${path%%@@*}
printf '%s\n' "$path"
IFS=:
for d in $path; do
  [[ -x "$d/claude" ]] && echo "claude on login PATH: $d/claude" >&2
done
