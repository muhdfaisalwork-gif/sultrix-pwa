#!/usr/bin/env bash
# Local release build + signing of the Sultrix Android app. The keystore and its passwords live outside the repo
# (G:\sultrix_secrets) and are never printed. Output: releases/Sultrix-v2.2.56.apk
set -euo pipefail
cd "$(dirname "$0")/.."
BT="/c/Users/Lucifer/AppData/Local/Android/Sdk/build-tools/34.0.0"
CRED="/g/sultrix_secrets/sultrix-release.credentials.txt"
JKS="/g/sultrix_secrets/sultrix-release.jks"
getv() { grep -m1 "^$1" "$CRED" | sed -E 's/^[^=:]+[=:][[:space:]]*//' | tr -d '\r'; }
ALIAS="$(getv alias)"; export SULTRIX_KS_PASS="$(getv storepass)"; export SULTRIX_KEY_PASS="$(getv keypass)"   # passed to apksigner by environment variable name, never on the command line
echo "[1/4] cap sync"; npm run cap:sync
echo "[2/4] gradle assembleRelease"; (cd android && ./gradlew.bat assembleRelease)
UNSIGNED="$(ls android/app/build/outputs/apk/release/*.apk | head -1)"
echo "[3/4] zipalign + sign ($UNSIGNED)"
mkdir -p releases
"$BT/zipalign.exe" -f -p 4 "$UNSIGNED" releases/aligned.apk
"$BT/apksigner.bat" sign --ks "$JKS" --ks-key-alias "$ALIAS" --ks-pass env:SULTRIX_KS_PASS --key-pass env:SULTRIX_KEY_PASS --out releases/Sultrix-v2.2.56.apk releases/aligned.apk
rm -f releases/aligned.apk releases/Sultrix-v2.2.56.apk.idsig
echo "[4/4] verify"; "$BT/apksigner.bat" verify --print-certs releases/Sultrix-v2.2.56.apk | head -3
ls -la releases/Sultrix-v2.2.56.apk
echo BUILD_DONE_OK
