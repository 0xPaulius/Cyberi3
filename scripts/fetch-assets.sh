#!/usr/bin/env bash
# Downloads the Kenney "Modular character pack" (CC0) and normalizes it into
# assets/avatars/. Safe to re-run; set FORCE_ASSETS=1 to redownload.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/assets/avatars"
URL="${KENNEY_PACK_URL:-https://opengameart.org/sites/default/files/Kenney_characterPack_1.zip}"

if [ -f "$OUT/manifest.json" ] && [ "${FORCE_ASSETS:-0}" != "1" ]; then
  echo "avatar parts already present; skipping download (FORCE_ASSETS=1 to redo)"
  exit 0
fi

for bin in curl unzip node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "error: '$bin' is required" >&2; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "downloading Kenney modular character pack (CC0)..."
curl -fsSL --retry 3 --retry-delay 2 -o "$TMP/pack.zip" "$URL"

echo "extracting..."
unzip -q "$TMP/pack.zip" -d "$TMP/pack"

node "$ROOT/scripts/build-avatars.mjs" "$TMP/pack" "$OUT"
