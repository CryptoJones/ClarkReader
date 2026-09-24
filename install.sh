#!/usr/bin/env bash
# One-step setup for the ClarkReader server on Linux and macOS.
#
#   ./install.sh
#
# Finds a Python Kokoro supports (3.10-3.12), builds a venv beside this script, installs
# the server's requirements, builds the extension into dist/, and starts the server at
# login: a systemd user service on Linux, a launchd agent on macOS. Safe to run again.
#   ./install.sh --no-autostart    set up but do not start at login (and remove it if present)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
autostart=1
[[ "${1:-}" == "--no-autostart" ]] && autostart=0

# uv's installer puts it here, which a non-interactive shell may not have on PATH.
export PATH="$HOME/.local/bin:$PATH"

# Kokoro only installs on 3.10-3.12; a plain python3 is often newer and would fail.
py=""
for candidate in python3.12 python3.11 python3.10; do
  if command -v "$candidate" >/dev/null 2>&1; then py="$candidate"; break; fi
done

venv="$here/.venv"
if [[ ! -x "$venv/bin/python" ]]; then
  if [[ -n "$py" ]]; then
    echo "Using $($py --version)"
    "$py" -m venv "$venv" || {
      echo "Could not create a venv. On Debian/Ubuntu: sudo apt install python3-venv" >&2
      rm -rf "$venv"; exit 1
    }
  else
    # No usable Python. uv downloads a standalone 3.12 into its own directory: no admin
    # rights, no Homebrew, no compiler.
    if ! command -v uv >/dev/null 2>&1; then
      echo "No Python 3.10, 3.11 or 3.12 found (Kokoro does not install on 3.13 or newer)."
      reply="${CLARKREADER_INSTALL_UV:-}"
      if [[ -z "$reply" && -t 0 ]]; then
        read -r -p "Install uv (https://astral.sh/uv) into ~/.local/bin to fetch Python 3.12? [Y/n] " reply
        reply="${reply:-y}"
      fi
      case "${reply:-n}" in
      [Yy]*)
        curl -LsSf https://astral.sh/uv/install.sh | sh
        ;;
      *)
        cat >&2 <<'MSG'
Install Python 3.10-3.12 yourself, then run this again:
  Debian/Ubuntu   sudo apt install python3.12 python3.12-venv   (or the deadsnakes PPA)
  Fedora          sudo dnf install python3.12
  macOS           brew install python@3.12
Or set CLARKREADER_INSTALL_UV=y to let this script install uv for you.
MSG
        exit 1
        ;;
      esac
    fi
    echo "Fetching Python 3.12 with uv"
    uv venv --python 3.12 "$venv"
  fi
fi

echo "Installing the server (PyTorch is a large download the first time)..."
if [[ -x "$venv/bin/pip" ]]; then
  "$venv/bin/pip" install --disable-pip-version-check -r "$here/server/requirements.txt"
else
  uv pip install --python "$venv/bin/python" -r "$here/server/requirements.txt"
fi

# The server downloads a spaCy model on first use and spaCy shells out to pip for it, but
# a uv-made venv has none. Without this the first read crashes the server.
if ! "$venv/bin/python" -m pip --version >/dev/null 2>&1; then
  uv pip install --python "$venv/bin/python" pip
fi

"$here/build.sh"

server_cmd="$venv/bin/python $here/server/clarkreader_server.py"

case "$(uname -s)" in
Linux)
  unit_dir="$HOME/.config/systemd/user"
  unit="$unit_dir/clarkreader.service"
  if (( autostart )) && command -v systemctl >/dev/null 2>&1; then
    mkdir -p "$unit_dir"
    cat >"$unit" <<UNIT
[Unit]
Description=ClarkReader local Kokoro TTS server
After=default.target

[Service]
Type=simple
ExecStart=$server_cmd
WorkingDirectory=$here
Restart=on-failure
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable clarkreader
    systemctl --user restart clarkreader
    echo "Server running as a systemd user service (systemctl --user status clarkreader)."
  elif (( ! autostart )); then
    if [[ -f "$unit" ]]; then
      systemctl --user disable --now clarkreader 2>/dev/null || true
      rm -f "$unit"
      echo "Auto-start removed."
    fi
  else
    echo "systemd not found; start the server yourself with: server/run.sh"
  fi
  ;;
Darwin)
  plist="$HOME/Library/LaunchAgents/net.clarkreader.server.plist"
  domain="gui/$(id -u)"
  if (( autostart )); then
    mkdir -p "$(dirname "$plist")"
    cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>net.clarkreader.server</string>
  <key>ProgramArguments</key><array>
    <string>$venv/bin/python</string>
    <string>$here/server/clarkreader_server.py</string>
  </array>
  <key>WorkingDirectory</key><string>$here</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/clarkreader.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/clarkreader.log</string>
</dict></plist>
PLIST
    launchctl bootout "$domain" "$plist" 2>/dev/null || true
    launchctl bootstrap "$domain" "$plist"
    echo "Server running as a launchd agent (log: ~/Library/Logs/clarkreader.log)."
  elif [[ -f "$plist" ]]; then
    launchctl bootout "$domain" "$plist" 2>/dev/null || true
    rm -f "$plist"
    echo "Auto-start removed."
  fi
  ;;
esac

if (( ! autostart )); then
  echo "Start the server with: server/run.sh"
fi
echo "The first start downloads the voice and takes a couple of minutes."

cat <<MSG

Last step, in your browser:
  Chrome   chrome://extensions -> Developer mode -> Load unpacked -> $here/dist/chrome
  Firefox  about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> $here/dist/firefox/manifest.json
MSG
