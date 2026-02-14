#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_FILE="${ROOT_DIR}/homebrew/Casks/monospire.rb"

usage() {
  cat <<'USAGE'
Generate a Homebrew cask file for Monospire.

Usage:
  scripts/generate-homebrew-cask.sh --dmg /path/to/Monospire.dmg --url https://.../Monospire.dmg [--version 1.2.1] [--homepage https://...]

Required:
  --dmg       Local DMG path used to compute SHA256.
  --url       Public release URL to that DMG.

Optional:
  --version   App version (defaults to package.json version).
  --homepage  Project homepage URL (defaults to placeholder).
  --output    Output cask path (defaults to homebrew/Casks/monospire.rb).
USAGE
}

DMG_PATH=""
DMG_URL=""
APP_VERSION=""
HOMEPAGE_URL="https://github.com/your-org/monospire"

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

if [[ -z "${DMG_PATH}" || -z "${DMG_URL}" ]]; then
  usage
  exit 1
fi

if [[ ! -f "${DMG_PATH}" ]]; then
  echo "DMG not found: ${DMG_PATH}" >&2
  exit 1
fi

if [[ -z "${APP_VERSION}" ]]; then
  APP_VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
fi

SHA256="$(shasum -a 256 "${DMG_PATH}" | awk '{print $1}')"
mkdir -p "$(dirname "${OUT_FILE}")"

cat > "${OUT_FILE}" <<EOF
cask "monospire" do
  version "${APP_VERSION}"
  sha256 "${SHA256}"

  url "${DMG_URL}"
  name "Monospire"
  desc "Native-feeling macOS Markdown editor with dual editing views"
  homepage "${HOMEPAGE_URL}"

  auto_updates true
  depends_on macos: ">= :ventura"

  app "Monospire.app"

  zap trash: [
    "~/Library/Application Support/Monospire",
    "~/Library/Preferences/com.monospire.app.plist",
    "~/Library/Saved Application State/com.monospire.app.savedState",
  ]
end
EOF

echo "Wrote ${OUT_FILE}"
echo "version=${APP_VERSION}"
echo "sha256=${SHA256}"

