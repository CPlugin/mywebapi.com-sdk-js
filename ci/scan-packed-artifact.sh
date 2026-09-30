#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  printf 'usage: %s GITLEAKS_BIN EXTRACTED_ARTIFACT_DIR\n' "$0" >&2
  exit 2
fi
scanner="$(realpath "$1")"
source_dir="$(realpath "$2")"
if [[ ! -x "$scanner" || ! -d "$source_dir" ]]; then
  printf 'gitleaks scanner or artifact directory is unavailable\n' >&2
  exit 1
fi
log_file="${GITLEAKS_LOG:-$(mktemp "${TMPDIR:?TMPDIR must be set}/gitleaks-output.XXXXXX")}"
# Keep the CLI's own byte metric as the source of truth. A selected-file byte
# count is not a substitute for the scanner's reported scan metric.
set +e
"$scanner" dir --no-banner --verbose --no-color --redact --exit-code 1 "$source_dir" 2>&1 | tee "$log_file"
scan_status="${PIPESTATUS[0]}"
set -e
scanned_bytes="$(python3 - "$log_file" <<'PY'
from pathlib import Path
import re
import sys
text = Path(sys.argv[1]).read_text(encoding='utf-8', errors='replace')
matches = re.findall(r'scanned\s+~([0-9]+)\s+bytes', text)
if len(matches) != 1 or int(matches[0]) <= 0:
    raise SystemExit('gitleaks output did not report exactly one positive scanned-byte metric')
print(matches[0])
PY
)"
printf 'gitleaks scanned bytes: %s\n' "$scanned_bytes"
if (( scan_status != 0 )); then
  exit "$scan_status"
fi