#!/bin/sh
# Checks TerminalSessions.tla, then each mutant, which must break the rule it names.
# --confirm records the covered files as described by the spec, once the checks pass.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tlc_tool='http:tla2tools[url=https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar,checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88]@1.7.4'
java_tool='java@temurin-25'
work=$(mktemp -d "${TMPDIR:-/tmp}/terminal-sessions.XXXXXX")
trap 'rm -rf "$work"' EXIT
export MISE_CEILING_PATHS="$work"
cd "$work"
mise install --quiet "$java_tool" "$tlc_tool" >/dev/null
jar="$(mise where "$tlc_tool")/tla2tools.jar"
java=$(mise which java --tool "$java_tool")
cp "$here/TerminalSessions.tla" .

tlc() {
  "$java" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -metadir "$work/states-$1" \
    -config "$1.cfg" TerminalSessions.tla > "$1.out" 2>&1 || true
}

sed 's/^  Mutant = .*/  Mutant = "none"/' "$here/TerminalSessions.cfg" > model.cfg
tlc model
if grep -q '^Model checking completed. No error has been found' model.out; then
  echo "model: every rule holds ($(grep -o '[0-9,]* distinct states found' model.out | tail -1))"
else
  cat model.out
  echo "model: a rule breaks; the trace above is in the code's terms per SKILL.md" >&2
  exit 1
fi

failed=0
while read -r mutant rule; do
  sed "s/^  Mutant = .*/  Mutant = \"$mutant\"/" "$here/TerminalSessions.cfg" > "$mutant.cfg"
  tlc "$mutant"
  if grep -Eq "(Invariant|Action property|property) $rule .*violated|$rule is violated" "$mutant.out"; then
    echo "mutant $mutant: breaks $rule as it must"
  else
    echo "mutant $mutant: did NOT break $rule; the model no longer guards it" >&2
    grep -E 'violated|Error|error' "$mutant.out" | head -5 >&2 || true
    failed=1
  fi
done <<'LIST'
reconcileLosesUnsent LostOnlyWhenLost
closeSkipsTerminate NoHiddenShell
reconcileKeepsTabless NoHiddenShell
createIgnoresExit EndedStaysEnded
exitsDuringListDropped NoDeadTab
sendWithoutStartingCheck NoHiddenShell
LIST
[ "$failed" -eq 0 ] || exit 1

# The spec is a hand model, so a pass says nothing about covered code changed since it was confirmed.
# shellcheck disable=SC2016
covered=$(grep -o '^| `[^`]*/[^`]*`' "$here/SKILL.md" | sed 's/^| `//; s/`$//')
root=$(git -C "$here" rev-parse --show-toplevel)
fingerprint() {
  for f in $covered; do
    if [ ! -f "$root/$f" ]; then
      echo "stale: covered file $f is gone; fix the table in SKILL.md and the spec" >&2
      exit 3
    fi
    printf '%s  %s\n' "$(git -C "$root" hash-object -- "$f")" "$f"
  done
}
fingerprint > "$work/covered-files.txt"
if [ "${1:-}" = "--confirm" ]; then
  cp "$work/covered-files.txt" "$here/covered-files.txt"
  echo "confirmed: covered-files.txt now records the covered files as they are"
  exit 0
fi
if ! diff -u "$here/covered-files.txt" "$work/covered-files.txt" > "$work/covered.diff"; then
  echo "stale: these covered files changed since the spec was last confirmed:" >&2
  sed -n 's/^+[0-9a-f]\{40\}  /  /p' "$work/covered.diff" >&2
  echo "read them against TerminalSessions.tla, then rerun with --confirm (SKILL.md)" >&2
  exit 3
fi
echo "in step: every covered file matches covered-files.txt"
