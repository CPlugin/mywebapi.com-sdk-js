#!/usr/bin/env bash
set -euo pipefail

# Pin the scanner version; only the official release asset and its published
# checksum are accepted.
readonly GITLEAKS_VERSION="8.24.3"
destination="${1:?usage: install-gitleaks.sh DESTINATION}"
mkdir -p -- "$destination"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) platform=linux_x64 ;;
  Linux:aarch64) platform=linux_arm64 ;;
  *) printf 'unsupported gitleaks runner platform: %s:%s\n' "$(uname -s)" "$(uname -m)" >&2; exit 1 ;;
esac
archive="gitleaks_${GITLEAKS_VERSION}_${platform}.tar.gz"
base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"
tmp="$(mktemp -d "${TMPDIR:?TMPDIR must be set}/gitleaks.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT
curl --fail --location --silent --show-error "$base/$archive" --output "$tmp/$archive"
curl --fail --location --silent --show-error "$base/gitleaks_${GITLEAKS_VERSION}_checksums.txt" --output "$tmp/checksums.txt"
test -s "$tmp/$archive"
test -s "$tmp/checksums.txt"
checksum_line="$(grep -E "[[:space:]]$archive$" "$tmp/checksums.txt")"
if [[ -z "$checksum_line" || "$(printf '%s\n' "$checksum_line" | wc -l)" != 1 ]]; then
  printf 'missing or ambiguous checksum for %s\n' "$archive" >&2
  exit 1
fi
(cd "$tmp" && printf '%s\n' "$checksum_line" | sha256sum --check --strict --status -)
tar --extract --gzip --file "$tmp/$archive" --directory "$destination" gitleaks
chmod 0755 "$destination/gitleaks"
test -x "$destination/gitleaks"
"$destination/gitleaks" version