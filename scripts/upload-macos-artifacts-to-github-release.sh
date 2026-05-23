#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null && pwd -P)"

GITHUB_RELEASE_ARTIFACT_KIND="${GITHUB_RELEASE_ARTIFACT_KIND:-macOS}" \
GITHUB_RELEASE_ARTIFACT_PATTERNS="${GITHUB_RELEASE_ARTIFACT_PATTERNS:-*.dmg *.dmg.blockmap latest-mac.yml}" \
GITHUB_RELEASE_ARTIFACT_DIR="${GITHUB_RELEASE_ARTIFACT_DIR:-${ROOT_DIR}/dist}" \
"${ROOT_DIR}/scripts/upload-linux-artifacts-to-github-release.sh" "$@"
