#!/usr/bin/env bash
# Build release installers into release/:
#   Cobander-<ver>-win-x64.exe      NSIS one-click (electron-builder via wine)
#   Cobander-<ver>-mac-arm64.zip    .app ad-hoc signed with rcodesign, zipped with symlinks kept
#   Cobander-<ver>-mac-x64.zip
#   latest.json                    updater manifest (notes = top section of CHANGELOG.md)
# usage: scripts/build.sh [all|win|mac]
set -euo pipefail
cd "$(dirname "$0")/.."
WHAT="${1:-all}"
VER=$(node -p "require('./package.json').version")
RCODESIGN="${RCODESIGN:-/home/claude/tools/rcodesign}"
export ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-$HOME/.cache/electron-builder}"
mkdir -p release
rm -rf release/*-unpacked release/mac release/mac-arm64 release/builder-*.y*ml

if [[ "$WHAT" == all || "$WHAT" == win ]]; then
  npx electron-builder --win nsis --x64 --publish never
fi

if [[ "$WHAT" == all || "$WHAT" == mac ]]; then
  npx electron-builder --mac dir --arm64 --x64 --publish never
  for pair in "mac-arm64:arm64" "mac:x64"; do
    dir="release/${pair%%:*}"; arch="${pair##*:}"
    app="$dir/Cobander.app"
    [[ -d "$app" ]] || { echo "missing $app" >&2; exit 1; }
    if [[ -x "$RCODESIGN" ]]; then "$RCODESIGN" sign "$app" >/dev/null; else echo "WARNING: rcodesign not found; mac build is unsigned" >&2; fi
    out="release/Cobander-${VER}-mac-${arch}.zip"; rm -f "$out"
    (cd "$dir" && zip -qry "../$(basename "$out")" Cobander.app)
  done
fi

node scripts/manifest.js "$VER"
ls -la release/*.exe release/*.zip release/latest.json 2>/dev/null || true
