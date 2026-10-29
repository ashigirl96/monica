#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
log_dir="${MONICA_IOS_LOG_DIR:-/tmp/monica-ios-check-$$}"
mkdir -p "$log_dir"
simulator=""
fixture=""
cleanup() {
  if [[ -n "$fixture" ]]; then kill "$fixture" 2>/dev/null || true; wait "$fixture" 2>/dev/null || true; fi
  if [[ -n "$simulator" ]]; then xcrun simctl shutdown "$simulator" >/dev/null 2>&1 || true; xcrun simctl delete "$simulator"; fi
  rm -f apps/ios/Tests/fixtures.json
}
trap cleanup EXIT
bun run --cwd apps/ios build
bun apps/ios/testing.ts > "$log_dir/fixtures.log" 2>&1 &
fixture=$!
for ((i=0; i<100; i++)); do
  if grep -q 'fixtures ready' "$log_dir/fixtures.log"; then break; fi
  kill -0 "$fixture"
  sleep 0.1
done
grep -q 'fixtures ready' "$log_dir/fixtures.log"
runtime=$(xcrun simctl list runtimes -j | bun -e 'const x=await Bun.stdin.json(); const r=x.runtimes.filter(r=>r.isAvailable&&r.name.startsWith("iOS ")&&parseFloat(r.version)>=26.2).at(-1); if(!r)throw Error("Install an iOS 26.2+ Simulator runtime in Xcode");console.log(r.identifier)')
simulator=$(xcrun simctl create "monica-native-check-$$" 'iPhone 17' "$runtime")
xcrun simctl boot "$simulator"
xcrun simctl bootstatus "$simulator" -b
xcodebuild -project apps/ios/Monica.xcodeproj -scheme Monica -sdk iphonesimulator -destination "platform=iOS Simulator,id=$simulator" -derivedDataPath apps/ios/DerivedData -resultBundlePath "$log_dir/Native.xcresult" -collect-test-diagnostics never -parallel-testing-enabled NO -test-timeouts-enabled YES -default-test-execution-time-allowance 20 -maximum-test-execution-time-allowance 40 test > "$log_dir/xcodebuild.log" 2>&1 || { tail -100 "$log_dir/xcodebuild.log"; exit 1; }
xcodebuild -project apps/ios/Monica.xcodeproj -scheme Monica -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath apps/ios/DerivedData CODE_SIGNING_ALLOWED=NO build > "$log_dir/iphoneos-build.log" 2>&1 || { tail -100 "$log_dir/iphoneos-build.log"; exit 1; }
echo "Native Simulator tests and unsigned device build passed. Logs: $log_dir"
