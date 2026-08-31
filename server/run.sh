#!/usr/bin/env bash
# Start the ClarkReader TTS server.
#
# Kokoro needs torch, which is a large install, so this reuses NarratorTool's venv by
# default rather than building a second copy of it. Override with:
#   CLARKREADER_PYTHON=/path/to/python ./run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pick_python() {
  if [[ -n "${CLARKREADER_PYTHON:-}" ]]; then echo "$CLARKREADER_PYTHON"; return; fi
  for candidate in \
      "$here/../.venv/bin/python" \
      "$HOME/Source/repos/NarratorTool/.venv/bin/python"; do
    if [[ -x "$candidate" ]] && "$candidate" -c 'import kokoro' 2>/dev/null; then
      echo "$candidate"; return
    fi
  done
  return 1
}

if ! python_bin="$(pick_python)"; then
  cat >&2 <<'MSG'
No Python with kokoro installed was found.

Either point CLARKREADER_PYTHON at one:
    CLARKREADER_PYTHON=/path/to/venv/bin/python ./run.sh

or build a venv beside this script:
    python3 -m venv ../.venv && ../.venv/bin/pip install -r requirements.txt
MSG
  exit 1
fi

echo "ClarkReader: using $python_bin"
exec "$python_bin" "$here/clarkreader_server.py" "$@"
