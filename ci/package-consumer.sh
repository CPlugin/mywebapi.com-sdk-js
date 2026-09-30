#!/usr/bin/env bash
set -euo pipefail

if (( $# < 1 )); then
  printf 'usage: %s ARTIFACT [CONSUMER_ROOT] [--browser]\n' "$0" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact="$(realpath "$1")"
consumer_root="${2:-$(mktemp -d "${TMPDIR:?TMPDIR must be set}/sdk-consumer.XXXXXX")}"
run_browser=0
for option in "${@:3}"; do
  case "$option" in
    --browser) run_browser=1 ;;
    *) printf 'unknown option: %s\n' "$option" >&2; exit 2 ;;
  esac
done

if [[ ! -s "$artifact" ]]; then
  printf 'packed artifact is missing or empty: %s\n' "$artifact" >&2
  exit 1
fi
rm -rf -- "$consumer_root"
mkdir -p -- "$consumer_root"

(
  cd "$consumer_root"
  npm init --yes
)
(
  cd "$consumer_root"
  npm install --ignore-scripts --no-audit --no-fund --omit=dev "$artifact"
)

export SDK_CONSUMER_ROOT="$consumer_root"
node "$repo_root/ci/consumer-import.mjs"
bun "$repo_root/ci/consumer-import.mjs"
node "$repo_root/ci/consumer-regression.mjs"
bun "$repo_root/ci/consumer-regression.mjs"

cp "$repo_root/ci/consumer-types.ts" "$consumer_root/consumer-types.ts"
cat > "$consumer_root/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["consumer-types.ts"]
}
JSON
"$repo_root/node_modules/.bin/tsc" --noEmit --project "$consumer_root/tsconfig.json"

if (( run_browser )); then
  browser_entry="$consumer_root/browser-entry.ts"
  browser_output="$consumer_root/browser-dist"
  cat > "$browser_entry" <<'TS'
import { ApiError, CPluginWebApiClient } from '@mywebapi.com/sdk';
if (typeof ApiError !== 'function' || typeof CPluginWebApiClient !== 'function') {
  throw new Error('browser consumer exports are missing');
}
document.querySelector('#result')?.setAttribute('data-status', 'ok');
TS
  bun build "$browser_entry" --outdir "$browser_output" --target browser --format esm
  cat > "$consumer_root/browser-consumer.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>SDK browser consumer</title>
<output id="result" data-status="error">running</output>
<script type="module" src="/browser-dist/browser-entry.js"></script>
HTML
  chrome="${CHROME_BIN:-}"
  if [[ -z "$chrome" ]]; then
    for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
      if command -v "$candidate" >/dev/null 2>&1; then chrome="$(command -v "$candidate")"; break; fi
    done
  fi
  if [[ -z "$chrome" ]]; then
    printf 'browser consumer requested but no Chromium executable is available\n' >&2
    exit 1
  fi
  port="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1])
PY
)"
  (cd "$consumer_root" && python3 -m http.server "$port" --bind 127.0.0.1 >"$consumer_root/http.log" 2>&1) &
  server_pid=$!
  cleanup_browser() { kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; }
  trap cleanup_browser EXIT
  for _ in {1..20}; do
    if curl --fail --silent "http://127.0.0.1:$port/browser-consumer.html" >/dev/null; then break; fi
    sleep 0.25
  done
  dom="$consumer_root/browser-dom.html"
  timeout 30s "$chrome" --headless=new --no-sandbox --disable-gpu --virtual-time-budget=5000 --dump-dom "http://127.0.0.1:$port/browser-consumer.html" >"$dom"
  python3 - "$dom" <<'PY'
from pathlib import Path
import sys
html = Path(sys.argv[1]).read_text(encoding='utf-8')
if 'data-status="ok"' not in html and "data-status='ok'" not in html:
    raise SystemExit('browser consumer did not report data-status=ok')
print('browser consumer: ok')
PY
fi

printf 'packed consumer checks passed for %s\n' "$artifact"
