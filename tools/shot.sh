#!/usr/bin/env bash
# Headless-Chrome screenshot of the running app: tools/shot.sh <name> "<query string>"
# Writes renders/ui/<name>.png and renders/ui/<name>.log (console output, so page errors can be grepped).
set -u
cd "$(dirname "$0")/.."
mkdir -p renders/ui
name="$1"; qs="${2:-}"
timeout "${SHOT_TIMEOUT:-420}" google-chrome --headless --disable-gpu --no-sandbox --hide-scrollbars --window-size=1600,900 \
  --enable-logging=stderr --v=0 --virtual-time-budget="${SHOT_BUDGET:-4000}" \
  --screenshot="renders/ui/${name}.png" "http://127.0.0.1:8105/?${qs}" > "renders/ui/${name}.log" 2>&1
echo "${name}: exit $? $(ls -la renders/ui/${name}.png 2>/dev/null | awk '{print $5}') bytes; errors: $(grep -E 'Uncaught|TypeError|ReferenceError|SyntaxError|is not defined|is not a function' "renders/ui/${name}.log" | grep -v chrome-extension | head -3)"
