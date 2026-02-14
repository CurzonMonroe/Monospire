#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

BUILDER="./node_modules/.bin/electron-builder"
if [[ ! -x "$BUILDER" ]]; then
  echo "electron-builder is not installed. Run: npm install"
  exit 1
fi

# Supported values: universal (default), arm64, x64
ARCH="${MONOSPIRE_ARCH:-universal}"
ARGS=(--mac --dir)
case "$ARCH" in
  universal)
    ARGS+=(--universal)
    ;;
  arm64)
    ARGS+=(--arm64)
    ;;
  x64)
    ARGS+=(--x64)
    ;;
  *)
    echo "Invalid MONOSPIRE_ARCH: $ARCH"
    echo "Use one of: universal, arm64, x64"
    exit 1
    ;;
esac

echo "Packaging Monospire .app (arch: $ARCH)..."
"$BUILDER" "${ARGS[@]}"

APP_PATH="$(find "$ROOT_DIR/dist" -maxdepth 4 -type d -name "Monospire.app" | head -n 1 || true)"
if [[ -z "$APP_PATH" ]]; then
  echo "Packaging completed, but Monospire.app was not found under dist/"
  exit 1
fi

echo "Built app:"
echo "$APP_PATH"
