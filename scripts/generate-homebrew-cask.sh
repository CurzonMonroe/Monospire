#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_FILE="${ROOT_DIR}/homebrew/Casks/monospire.rb"

usage() {
  cat <<'USAGE'
Generate a Homebrew cask file for Monospire.

Usage:
  scripts/generate-homebrew-cask.sh [--dmg /path/to/Monospire.dmg] [--url https://.../Monospire.dmg] [--version 1.2.2] [--homepage https://...]

Defaults:
  --version      App version from package.json.
  --dmg          dist/Monospire-<version>-arm64.dmg.
  --url          GitHub release URL for v<version>.
  --homepage     https://github.com/CurzonMonroe/Monospire.
  --output       homebrew/Casks/monospire.rb.
  --release-dir  homebrew/Casks/Monospire.dmg.
USAGE
}

DMG_PATH=""
DMG_URL=""
APP_VERSION=""
HOMEPAGE_URL="https://github.com/CurzonMonroe/Monospire"
RELEASE_DIR="${ROOT_DIR}/homebrew/Casks/Monospire.dmg"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dmg)
      DMG_PATH="${2:-}"
      shift 2
      ;;
    --url)
      DMG_URL="${2:-}"
      shift 2
      ;;
    --version)
      APP_VERSION="${2:-}"
      shift 2
      ;;
    --homepage)
      HOMEPAGE_URL="${2:-}"
      shift 2
      ;;
    --output)
      OUT_FILE="${2:-}"
      shift 2
      ;;
    --release-dir)
      RELEASE_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${APP_VERSION}" ]]; then
  APP_VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
fi

if [[ -z "${DMG_PATH}" ]]; then
  DMG_PATH="${ROOT_DIR}/dist/Monospire-${APP_VERSION}-arm64.dmg"
fi

if [[ -z "${DMG_URL}" ]]; then
  DMG_URL="https://github.com/CurzonMonroe/Monospire/releases/download/v${APP_VERSION}/Monospire-${APP_VERSION}-arm64.dmg"
fi

if [[ ! -f "${DMG_PATH}" ]]; then
  echo "DMG not found: ${DMG_PATH}" >&2
  exit 1
fi

SHA256="$(shasum -a 256 "${DMG_PATH}" | awk '{print $1}')"
mkdir -p "$(dirname "${OUT_FILE}")"
mkdir -p "${RELEASE_DIR}"

cat > "${OUT_FILE}" <<EOF
cask "monospire" do
  version "${APP_VERSION}"
  sha256 "${SHA256}"

  url "${DMG_URL}"
  name "Monospire"
  desc "A focused Markdown editor"
  homepage "${HOMEPAGE_URL}"

  depends_on macos: ">= :ventura"

  app "Monospire.app"
  binary "#{appdir}/Monospire.app/Contents/Resources/app/scripts/monospire-cli", target: "monospire"

  zap trash: [
    "~/Library/Application Support/Monospire",
    "~/Library/Preferences/com.monospire.app.plist",
    "~/Library/Saved Application State/com.monospire.app.savedState",
  ]
end
EOF

find "${RELEASE_DIR}" -maxdepth 1 -type f \( \
  -name 'Monospire-*.dmg' -o \
  -name 'Monospire-*.dmg.blockmap' -o \
  -name 'latest-mac.yml' -o \
  -name 'builder-effective-config.yaml' -o \
  -name 'builder-debug.yml' \
\) -delete
find "${RELEASE_DIR}" -maxdepth 1 -type d -name 'mac-*' -exec rm -rf {} +

cp "${DMG_PATH}" "${RELEASE_DIR}/"
for artifact in \
  "${DMG_PATH}.blockmap" \
  "${ROOT_DIR}/dist/latest-mac.yml" \
  "${ROOT_DIR}/dist/builder-effective-config.yaml" \
  "${ROOT_DIR}/dist/builder-debug.yml"
do
  if [[ -f "${artifact}" ]]; then
    cp "${artifact}" "${RELEASE_DIR}/"
  fi
done

echo "Wrote ${OUT_FILE}"
echo "Copied release artifacts to ${RELEASE_DIR}"
echo "version=${APP_VERSION}"
echo "sha256=${SHA256}"
