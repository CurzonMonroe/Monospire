#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null && pwd -P)"
APP_VERSION="$(cd "${ROOT_DIR}" >/dev/null && node -p "require('./package.json').version")"
TAG_NAME="${GITHUB_RELEASE_TAG:-v${APP_VERSION}}"
REPO="${GITHUB_RELEASE_REPO:-CurzonMonroe/Monospire}"
TOKEN="${GH_RELEASE_TOKEN:-${GITHUB_RELEASE_TOKEN:-}}"
ARTIFACT_DIR="${GITHUB_RELEASE_ARTIFACT_DIR:-${ROOT_DIR}/dist}"
DRY_RUN="false"

usage() {
  cat <<'USAGE'
Upload Linux distribution artifacts to a GitHub release.

Usage:
  scripts/upload-linux-artifacts-to-github-release.sh [--dry-run]

Environment:
  GH_RELEASE_TOKEN       GitHub token with permission to create/edit releases.
  GITHUB_RELEASE_TOKEN   Alternative token variable name.
  GITHUB_RELEASE_REPO    Repository owner/name. Defaults to CurzonMonroe/Monospire.
  GITHUB_RELEASE_TAG     Release tag. Defaults to v<package.json version>.
  GITHUB_RELEASE_ARTIFACT_DIR
                         Directory containing Linux artifacts. Defaults to dist.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN="true"
      shift
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

ARTIFACTS=()
while IFS= read -r artifact; do
  ARTIFACTS+=("${artifact}")
done < <(
  find "${ARTIFACT_DIR}" -maxdepth 1 -type f \( \
    -name '*.AppImage' -o \
    -name '*.deb' -o \
    -name '*.rpm' -o \
    -name '*.tar.xz' \
  \) | sort
)

if [[ "${#ARTIFACTS[@]}" -eq 0 ]]; then
  echo "No Linux artifacts found in ${ARTIFACT_DIR}" >&2
  exit 1
fi

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "Would upload ${#ARTIFACTS[@]} artifact(s) to ${REPO} release ${TAG_NAME}:"
  printf '  %s\n' "${ARTIFACTS[@]}"
  exit 0
fi

if [[ -z "${TOKEN}" ]]; then
  echo "GH_RELEASE_TOKEN or GITHUB_RELEASE_TOKEN must be set." >&2
  exit 1
fi

api_request() {
  local method="$1"
  local url="$2"
  local data="${3:-}"

  if [[ -n "${data}" ]]; then
    curl --fail-with-body --silent --show-error \
      -X "${method}" \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "Content-Type: application/json" \
      --data "${data}" \
      "${url}"
  else
    curl --fail-with-body --silent --show-error \
      -X "${method}" \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "${url}"
  fi
}

json_value() {
  node -e '
const fs = require("fs");
const path = process.argv[1];
const input = fs.readFileSync(0, "utf8");
const data = JSON.parse(input);
const value = path.split(".").reduce((current, key) => current && current[key], data);
if (value !== undefined && value !== null) process.stdout.write(String(value));
' "$1"
}

release_json=""
if release_json="$(api_request GET "https://api.github.com/repos/${REPO}/releases/tags/${TAG_NAME}" 2>/tmp/monospire-github-release-error.log)"; then
  echo "Found GitHub release ${TAG_NAME}."
else
  echo "Creating GitHub release ${TAG_NAME}."
  release_json="$(api_request POST "https://api.github.com/repos/${REPO}/releases" "{\"tag_name\":\"${TAG_NAME}\",\"name\":\"Monospire ${TAG_NAME}\",\"draft\":false,\"prerelease\":false}")"
fi

release_id="$(printf '%s' "${release_json}" | json_value id)"
if [[ -z "${release_id}" ]]; then
  echo "Unable to determine GitHub release id for ${TAG_NAME}." >&2
  exit 1
fi

assets_json="$(api_request GET "https://api.github.com/repos/${REPO}/releases/${release_id}/assets?per_page=100")"

for artifact in "${ARTIFACTS[@]}"; do
  name="$(basename "${artifact}")"
  encoded_name="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "${name}")"
  existing_asset_id="$(
    ASSET_NAME="${name}" node -e '
const fs = require("fs");
const assets = JSON.parse(fs.readFileSync(0, "utf8"));
const asset = assets.find((candidate) => candidate.name === process.env.ASSET_NAME);
if (asset) process.stdout.write(String(asset.id));
' <<<"${assets_json}"
  )"

  if [[ -n "${existing_asset_id}" ]]; then
    echo "Replacing existing GitHub release asset ${name}."
    api_request DELETE "https://api.github.com/repos/${REPO}/releases/assets/${existing_asset_id}" >/dev/null
  else
    echo "Uploading GitHub release asset ${name}."
  fi

  curl --fail-with-body --silent --show-error \
    -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"${artifact}" \
    "https://uploads.github.com/repos/${REPO}/releases/${release_id}/assets?name=${encoded_name}" \
    >/dev/null
done

echo "Uploaded ${#ARTIFACTS[@]} Linux artifact(s) to https://github.com/${REPO}/releases/tag/${TAG_NAME}"
