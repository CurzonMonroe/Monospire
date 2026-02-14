#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_SVG="$ROOT_DIR/assets/monospire-icon.svg"
TMP_PNG="$ROOT_DIR/assets/monospire-icon-1024.png"
ICONSET_DIR="$ROOT_DIR/assets/Monospire.iconset"
OUT_ICNS="$ROOT_DIR/assets/Monospire.icns"

if [[ ! -f "$SRC_SVG" ]]; then
  echo "Missing source icon: $SRC_SVG" >&2
  exit 1
fi

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

# Render SVG to 1024 PNG using QuickLook
qlmanage -t -s 1024 -o "$ROOT_DIR/assets" "$SRC_SVG" >/dev/null 2>&1 || true
if [[ -f "$ROOT_DIR/assets/monospire-icon.svg.png" ]]; then
  mv "$ROOT_DIR/assets/monospire-icon.svg.png" "$TMP_PNG"
fi

if [[ ! -f "$TMP_PNG" ]]; then
  echo "Could not render PNG from SVG. Please open the SVG and export a 1024x1024 PNG to:" >&2
  echo "  $TMP_PNG" >&2
  exit 1
fi

sips -z 16 16     "$TMP_PNG" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32     "$TMP_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32     "$TMP_PNG" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64     "$TMP_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128   "$TMP_PNG" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256   "$TMP_PNG" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$TMP_PNG" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512   "$TMP_PNG" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$TMP_PNG" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$TMP_PNG" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$ICONSET_DIR" -o "$OUT_ICNS"
echo "Built $OUT_ICNS"
