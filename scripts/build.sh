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
    if [[ -x "$RCODESIGN" && -n "${APPLE_P12:-}" ]]; then
      # Developer ID + hardened runtime (entitlements on the app and every nested helper), then notarize + staple when an
      # App Store Connect API key (rcodesign encode-app-store-connect-api-key JSON) is given. Without APPLE_P12: ad-hoc.
      # Unscoped settings reach only the main binary (a bundle-path scope doesn't reach inside it either), so every nested
      # Mach-O gets its own path scope: hardened runtime on all of them, entitlements on the helper apps' executables.
      ent=build/entitlements.mac.plist; args=(--code-signature-flags runtime -e "$ent")
      while IFS= read -r -d '' f; do
        m=$(od -An -tx1 -N4 "$f" 2>/dev/null | tr -d ' \n'); case "$m" in cffaedfe|cefaedfe|cafebabe|feedfacf|feedface) ;; *) continue ;; esac
        rel="${f#"$app"/}"; args+=(--code-signature-flags "$rel:runtime"); [[ "$rel" == *.app/Contents/MacOS/* ]] && args+=(-e "$rel:$ent")
      done < <(find "$app/Contents/Frameworks" -type f -print0)
      "$RCODESIGN" sign --p12-file "$APPLE_P12" --p12-password-file "$APPLE_P12_PASSWORD_FILE" --for-notarization "${args[@]}" "$app" >/dev/null
      if [[ -n "${APPLE_API_KEY_JSON:-}" ]]; then "$RCODESIGN" notary-submit --api-key-path "$APPLE_API_KEY_JSON" --staple --max-wait-seconds 1800 "$app"; fi
    elif [[ -x "$RCODESIGN" ]]; then "$RCODESIGN" sign "$app" >/dev/null; else echo "WARNING: rcodesign not found; mac build is unsigned" >&2; fi
    out="release/Cobander-${VER}-mac-${arch}.zip"; rm -f "$out" "release/BandPad-${VER}-mac-${arch}.zip"
    (cd "$dir" && zip -qry "../$(basename "$out")" Cobander.app)
    # MAC_COMPAT=1: the band folder's copy keeps the old bundle name so the BandPad (≤0.14.1) updater, which looks
    # for BandPad.app inside the zip, can still install this version. Inside it is Cobander. Drop once everyone is on 0.15+.
    if [[ "${MAC_COMPAT:-0}" == 1 ]]; then
      rm -rf "$dir/BandPad.app"; cp -R "$dir/Cobander.app" "$dir/BandPad.app"
      cout="release/BandPad-${VER}-mac-${arch}.zip"; rm -f "$cout"; (cd "$dir" && zip -qry "../$(basename "$cout")" BandPad.app); rm -rf "$dir/BandPad.app"
    fi
  done
fi

node scripts/manifest.js "$VER"
ls -la release/*.exe release/*.zip release/latest.json 2>/dev/null || true
