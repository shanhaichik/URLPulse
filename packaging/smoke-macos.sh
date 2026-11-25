#!/usr/bin/env bash
set -euo pipefail

image=$(node packaging/release.cjs checksum "$1")
work=$(mktemp -d)
trap 'hdiutil detach "$work/image" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
hdiutil attach -readonly -nobrowse -mountpoint "$work/image" "$image"
test "$(readlink "$work/image/Applications")" = /Applications
ditto "$work/image/Pulse URL.app" "$work/Pulse URL.app"
hdiutil detach "$work/image"

bundle="$work/Pulse URL.app"
executable="$bundle/Contents/MacOS/Pulse URL"
test "$(lipo -archs "$executable")" = "$(uname -m)"
if [[ ${PULSE_PUBLIC_RELEASE:-0} == 1 ]]; then
  node packaging/release.cjs verify-mac "$bundle" "$image"
fi
PULSE_SMOKE_EXECUTABLE="$executable" node e2e/desktop-smoke.mjs
PULSE_SMOKE_EXECUTABLE="$executable" node e2e/desktop-locale-smoke.mjs
