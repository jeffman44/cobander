#!/usr/bin/env bash
# Package a built release for shipping to Jeff's PC through the device bridge (≤30 MB per file):
#   /mnt/user-data/outputs/bp<ver>/  <installer>.partNN (25 MB), SHA256SUMS-<ver>.txt, latest.json,
#                                    UPDATE-<ver>.cmd, bandpad-src-<ver>.tgz (source backup — the cloud
#                                    workspace does not survive between sessions)
# UPDATE-<ver>.cmd (double-clicked on jeffpc) joins the parts, copies the installers + latest.json into
# the band Drive folder's installers/, deletes older installers there, silent-installs and relaunches.
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
OUT="/mnt/user-data/outputs/bp${VER}"
rm -rf "$OUT"; mkdir -p "$OUT"
FILES=("Cobander-${VER}-win-x64.exe" "Cobander-${VER}-mac-arm64.zip" "Cobander-${VER}-mac-x64.zip")
: > "$OUT/SHA256SUMS-${VER}.txt"
JOIN=""
for f in "${FILES[@]}"; do
  [[ -f "release/$f" ]] || { echo "missing release/$f" >&2; exit 1; }
  (cd release && sha256sum "$f") >> "$OUT/SHA256SUMS-${VER}.txt"
  split -b 25M -d -a 2 "release/$f" "$OUT/$f.part"
  parts=$(cd "$OUT" && ls "$f".part?? | sort | tr "\n" " ")
  plus=$(echo $parts | sed 's/ /+/g')
  JOIN+="copy /b ${plus} \"${f}\" >nul && del ${parts} && echo joined ${f} >> update-${VER}.log"$'\r\n'
done
cp release/latest.json "$OUT/latest.json"
tar czf "$OUT/bandpad-src-${VER}.tgz" --exclude=node_modules --exclude=release --exclude=.e2e -C .. "$(basename "$PWD")"

KEEP=""
for f in "${FILES[@]}"; do KEEP+=" if /i not \"%%~nxf\"==\"${f}\""; done
{
  printf '@echo off\r\nsetlocal\r\ncd /d "%%~dp0"\r\necho Cobander %s update > update-%s.log\r\n' "$VER" "$VER"
  printf '%s' "$JOIN"
  printf 'set INST=G:\\My Drive\\Band stuff\\Cobander\\installers\r\nif not exist "%%INST%%" mkdir "%%INST%%"\r\n'
  for f in "${FILES[@]}"; do printf 'copy /y "%s" "%%INST%%\\" >nul && echo copied %s to Drive >> update-%s.log\r\n' "$f" "$f" "$VER"; done
  printf 'for %%%%f in ("%%INST%%\\Cobander-*.exe" "%%INST%%\\Cobander-*.zip") do%s del "%%%%f" >nul 2>&1\r\n' "$KEEP"
  printf 'copy /y latest.json "%%INST%%\\latest.json" >nul && echo copied latest.json to Drive >> update-%s.log\r\n' "$VER"
  printf 'tasklist /fi "imagename eq Cobander.exe" | find /i "Cobander.exe" >nul\r\nif not errorlevel 1 (\r\n  echo Cobander is running - closing it first >> update-%s.log\r\n  taskkill /im Cobander.exe >nul 2>&1\r\n  timeout /t 4 >nul\r\n  taskkill /im Cobander.exe /f >nul 2>&1\r\n)\r\n' "$VER"
  printf 'start /wait "" "Cobander-%s-win-x64.exe" /S\r\necho installed %s >> update-%s.log\r\n' "$VER" "$VER" "$VER"
  printf 'start "" "%%LOCALAPPDATA%%\\Programs\\Cobander\\Cobander.exe"\r\necho launched >> update-%s.log\r\n' "$VER"
} > "$OUT/UPDATE-${VER}.cmd"
# PUBLISH-<ver>.cmd: the same join + copy to the band Drive, but no install — Jeff then updates through the
# in-app "Update now" bar like everyone else.
{
  printf '@echo off\r\nsetlocal\r\ncd /d "%%~dp0"\r\necho Cobander %s publish > publish-%s.log\r\n' "$VER" "$VER"
  printf '%s' "$JOIN"
  printf 'set INST=G:\\My Drive\\Band stuff\\Cobander\\installers\r\nif not exist "%%INST%%" mkdir "%%INST%%"\r\n'
  for f in "${FILES[@]}"; do printf 'copy /y "%s" "%%INST%%\\" >nul && echo copied %s to Drive >> publish-%s.log\r\n' "$f" "$f" "$VER"; done
  printf 'for %%%%f in ("%%INST%%\\Cobander-*.exe" "%%INST%%\\Cobander-*.zip") do%s del "%%%%f" >nul 2>&1\r\n' "$KEEP"
  printf 'copy /y latest.json "%%INST%%\\latest.json" >nul && echo copied latest.json to Drive >> publish-%s.log\r\n' "$VER"
} > "$OUT/PUBLISH-${VER}.cmd"
ls -la "$OUT"
