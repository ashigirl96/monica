#!/bin/bash
# usage: make-app.sh <out.app> <bundle id> <macos|resources> [plain|runtime|deep|deep-runtime]
#   R268_SDK: SDK を入れた directory（backend.ts をそこへ写して compile する）
#   R268_BUILD: compile の出力を置く directory
# probe の .app を組み、scripts/install-app.ts と同じ codesign と quarantine の解除をする。
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
sdk=${R268_SDK:?}
build=${R268_BUILD:?}
app=$1
bundle_id=$2
placement=$3
sign=${4:-plain}

mkdir -p "$build"
if [[ ! -x "$build/probe-shell" || "$here/shell.rs" -nt "$build/probe-shell" ]]; then
  rustc -O --edition 2021 "$here/shell.rs" -o "$build/probe-shell"
fi
if [[ ! -x "$build/monica-backend" || "$here/backend.ts" -nt "$build/monica-backend" ]]; then
  cp "$here/backend.ts" "$sdk/backend.ts"
  # scripts/build.ts の Backend と同じ flag。
  (cd "$sdk" && bun build --compile --minify-whitespace --minify-syntax --bytecode --format=esm \
    backend.ts --outfile "$build/monica-backend")
fi

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$build/probe-shell" "$app/Contents/MacOS/probe-shell"
cp "$build/monica-backend" "$app/Contents/MacOS/monica-backend"
claude="$sdk/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
case "$placement" in
  macos) cp "$claude" "$app/Contents/MacOS/claude" ;;
  resources) cp "$claude" "$app/Contents/Resources/claude" ;;
  *) echo "unknown placement: $placement" >&2; exit 2 ;;
esac
cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>probe-shell</string>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleName</key><string>MonicaClaudeProbe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>CFBundleVersion</key><string>0.0.0</string>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
PLIST

case "$sign" in
  plain) codesign --force --sign Monica "$app" ;;
  runtime) codesign --force --options runtime --sign Monica "$app" ;;
  deep) codesign --force --deep --sign Monica "$app" ;;
  deep-runtime) codesign --force --deep --options runtime --sign Monica "$app" ;;
  *) echo "unknown sign: $sign" >&2; exit 2 ;;
esac
xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
echo "made $app ($placement, $sign)"
