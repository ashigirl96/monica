#!/bin/bash
# usage: inspect.sh <app>
# probe の .app と、その中の claude の署名を読む（書き換えない）。
app=$1
claude=$(ls "$app/Contents/MacOS/claude" "$app/Contents/Resources/claude" 2>/dev/null | head -1)
echo "## codesign -dvv <app>"
codesign -dvv "$app" 2>&1 | grep -E '^(Identifier|CodeDirectory|Authority|TeamIdentifier|Sealed Resources)'
echo "## codesign --verify --deep --strict <app>"
codesign --verify --deep --strict --verbose=2 "$app" 2>&1
echo "exit=$?"
echo "## spctl -a -t exec <app>"
spctl -a -vvv -t exec "$app" 2>&1
echo "## codesign -dvv <claude>"
codesign -dvv "$claude" 2>&1 | grep -E '^(Identifier|CodeDirectory|Authority|TeamIdentifier|Runtime)'
echo "## codesign -d --entitlements - <claude>"
codesign -d --entitlements - --xml "$claude" 2>/dev/null | plutil -convert json -o - - 2>/dev/null
echo
echo "## codesign --verify --strict <claude>"
codesign --verify --strict --verbose=2 "$claude" 2>&1
echo "## spctl -a -t exec <claude>"
spctl -a -vvv -t exec "$claude" 2>&1
echo "## CodeResources の claude の行"
plutil -p "$app/Contents/_CodeSignature/CodeResources" | grep -A4 '/claude"'
