#!/usr/bin/env bash
# Run every Node check in order and exit non-zero if any of them fails.
#   tools/test.sh
# Needs only Node (no npm packages, no browser, no running server).
#
# Every step runs even if an earlier one fails, so a single run shows the whole picture; a summary
# is printed at the end and the exit status is 1 if any step failed, 0 otherwise.
#
# How failure is detected, per script:
#   check_presets.js        never sets a failing exit status itself (it only fails if it throws), so its
#                           output is inspected: the "matrix: N combos, M bad" line must be present with
#                           M = 0, and no preset row may say FAIL instead of LEGAL.
#   check_models.js         exit status (the script exits 1 when any build is bad).
#   check_teardown_spin.js  exit status (the script exits 1 above its wobble threshold).
#   check_app.js            exit status (an uncaught exception makes Node exit 1) plus the final
#                           "all ok in ..." line, because the script has no explicit failing exit.
#   check_arena.js          exit status; skipped with a message when the file does not exist.
#
# Environment:
#   NODE                    node binary to use (default: node)
#   CHECK_TIMEOUT           seconds allowed per step (default: 1200); needs the `timeout` command,
#                           otherwise steps run without a time limit
#   ALLOW_ILLEGAL_PRESETS   set to 1 to report presets that fail their own engineering checks as a
#                           warning instead of a failure
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NODE="${NODE:-node}"
CHECK_TIMEOUT="${CHECK_TIMEOUT:-1200}"

if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "test.sh: '$NODE' not found; install Node.js or set NODE=/path/to/node" >&2
  exit 2
fi

if command -v timeout >/dev/null 2>&1; then
  run() { timeout "$CHECK_TIMEOUT" "$@"; }
else
  echo "test.sh: 'timeout' command not found; running steps without a time limit"
  run() { "$@"; }
fi

results=()
failed=0
record() { # record <PASS|FAIL|SKIP> <name> [detail]
  results+=("$(printf '%-5s %s%s' "$1" "$2" "${3:+  ($3)}")")
  if [ "$1" = "FAIL" ]; then failed=1; fi
}
explain() { # explain <exit status> -> text
  if [ "$1" -eq 124 ]; then echo "timed out after ${CHECK_TIMEOUT}s"; else echo "exit status $1"; fi
}
banner() { printf '\n=== %s\n' "$1"; }

echo "test.sh: $("$NODE" --version) in $(pwd)"

# 1. Syntax check: catches a file that is broken mid-edit before the slower checks load it.
banner "syntax (node --check)"
syntax_bad=()
for f in static/bb_*.js tools/*.js; do
  [ -f "$f" ] || continue
  if ! "$NODE" --check "$f"; then syntax_bad+=("$f"); fi
done
if [ "${#syntax_bad[@]}" -eq 0 ]; then
  echo "all files parse"
  record PASS "syntax"
else
  record FAIL "syntax" "does not parse: ${syntax_bad[*]}"
fi

# 2. Engineering model only (no 3D): presets, then every chassis x module x hardpoint combination.
banner "tools/check_presets.js matrix"
out="$(run "$NODE" tools/check_presets.js matrix 2>&1)"
status=$?
printf '%s\n' "$out"
if [ "$status" -ne 0 ]; then
  record FAIL "check_presets.js matrix" "$(explain "$status")"
elif ! printf '%s\n' "$out" | grep -Eq '^matrix: [0-9]+ combos, 0 bad$'; then
  record FAIL "check_presets.js matrix" "no 'matrix: N combos, 0 bad' line in the output"
else
  # A preset row is "<name> <mass> lb <speed> mph LEGAL|FAIL ...".
  illegal="$(printf '%s\n' "$out" | grep -E '^[A-Za-z0-9_]+ +[0-9.]+ lb +[0-9.]+ mph +FAIL( |$)' | awk '{print $1}' | tr '\n' ' ')"
  if [ -z "$illegal" ]; then
    record PASS "check_presets.js matrix"
  elif [ "${ALLOW_ILLEGAL_PRESETS:-0}" = "1" ]; then
    record PASS "check_presets.js matrix" "warning: presets failing their own checks: ${illegal% }"
  else
    record FAIL "check_presets.js matrix" "presets failing their own checks: ${illegal% }"
  fi
fi

# 3. 3D model builders for every combination (the slowest step).
banner "tools/check_models.js"
run "$NODE" tools/check_models.js
status=$?
if [ "$status" -eq 0 ]; then record PASS "check_models.js"; else record FAIL "check_models.js" "$(explain "$status")"; fi

# 4. Teardown geometry on the presets.
banner "tools/check_teardown_spin.js"
run "$NODE" tools/check_teardown_spin.js
status=$?
if [ "$status" -eq 0 ]; then record PASS "check_teardown_spin.js"; else record FAIL "check_teardown_spin.js" "$(explain "$status")"; fi

# 5. Application layer against a fake DOM.
banner "tools/check_app.js"
out="$(run "$NODE" tools/check_app.js 2>&1)"
status=$?
printf '%s\n' "$out"
if [ "$status" -ne 0 ]; then
  record FAIL "check_app.js" "$(explain "$status")"
elif ! printf '%s\n' "$out" | grep -q '^all ok in '; then
  record FAIL "check_app.js" "exit status 0 but no final 'all ok in ...' line"
else
  record PASS "check_app.js"
fi

# 6. Arena mode (optional until the file lands).
banner "tools/check_arena.js"
if [ -f tools/check_arena.js ]; then
  run "$NODE" tools/check_arena.js
  status=$?
  if [ "$status" -eq 0 ]; then record PASS "check_arena.js"; else record FAIL "check_arena.js" "$(explain "$status")"; fi
else
  echo "tools/check_arena.js not found; skipping"
  record SKIP "check_arena.js" "file not present"
fi

banner "summary"
for r in "${results[@]}"; do echo "$r"; done
if [ "$failed" -ne 0 ]; then
  echo "test.sh: FAILED"
  exit 1
fi
echo "test.sh: OK"
