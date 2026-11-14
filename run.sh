#!/usr/bin/env bash
# Start BattleBot Designer from a fresh clone.
#   ./run.sh                      create/reuse ./.venv, install requirements.txt, serve on port 8105
#   PORT=9000 ./run.sh            serve on another port
#   HOST=127.0.0.1 ./run.sh       bind to loopback only (the default, 0.0.0.0, listens on all interfaces)
# Other environment variables:
#   PYTHON           interpreter used to create the virtualenv (default: python3)
#   VENV_DIR         virtualenv location (default: .venv next to this script)
#   BBD_SETUP_ONLY   set to 1 to create the virtualenv and install requirements, then exit without serving
# This script never stops a process that is already using the port; if the port is taken, the server
# exits with "Address already in use" and you should pick another PORT.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PYTHON="${PYTHON:-python3}"
VENV_DIR="${VENV_DIR:-.venv}"

# A usable virtualenv has both an interpreter and pip. `python3 -m venv` fails on systems where the
# ensurepip module is packaged separately (Debian/Ubuntu: python3-venv) and leaves a partial directory
# behind, so on failure that directory is removed and `python3 -m virtualenv` is tried instead.
venv_ok() { [ -x "$VENV_DIR/bin/python" ] && "$VENV_DIR/bin/python" -m pip --version >/dev/null 2>&1; }

if ! venv_ok; then
  if [ -e "$VENV_DIR" ]; then
    echo "run.sh: $VENV_DIR exists but is not a usable virtualenv (no interpreter or no pip)." >&2
    echo "run.sh: remove it, or point VENV_DIR somewhere else, then re-run." >&2
    exit 1
  fi
  # $VENV_DIR did not exist before this point, so removing it after a failed attempt is safe.
  echo "run.sh: creating virtualenv in $VENV_DIR"
  if ! "$PYTHON" -m venv "$VENV_DIR" >/dev/null 2>&1 || ! venv_ok; then
    rm -rf -- "$VENV_DIR"
    echo "run.sh: '$PYTHON -m venv' failed; trying '$PYTHON -m virtualenv'"
    if ! "$PYTHON" -m virtualenv "$VENV_DIR" >/dev/null 2>&1 || ! venv_ok; then
      rm -rf -- "$VENV_DIR"
      echo "run.sh: could not create a virtualenv with $PYTHON." >&2
      echo "run.sh: install the venv module (Debian/Ubuntu: sudo apt install python3-venv) or the 'virtualenv' package, then re-run." >&2
      exit 1
    fi
  fi
fi

# Reinstall only when requirements.txt is newer than the last successful install.
STAMP="$VENV_DIR/.requirements-installed"
if [ ! -f "$STAMP" ] || [ requirements.txt -nt "$STAMP" ]; then
  echo "run.sh: installing requirements"
  "$VENV_DIR/bin/python" -m pip install --disable-pip-version-check -r requirements.txt
  touch "$STAMP"
fi

if [ "${BBD_SETUP_ONLY:-0}" = "1" ]; then
  echo "run.sh: setup complete (BBD_SETUP_ONLY=1, not starting the server)"
  exit 0
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8105}"
echo "run.sh: serving on http://127.0.0.1:${PORT} (bind host ${HOST})"
exec "$VENV_DIR/bin/python" server.py
