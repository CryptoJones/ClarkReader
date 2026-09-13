#!/usr/bin/env bash
# Sign the Firefox build with Mozilla so it installs permanently.
#
# Regular Firefox refuses to keep any extension Mozilla has not signed; the only
# unsigned route is a temporary load from about:debugging, which lasts one session.
# Signing as UNLISTED is free, creates no public listing, and comes back in minutes
# as an .xpi that installs once and stays. Every version needs it again, so this is
# the whole ceremony: build, sign, print where the file is.
#
#   export WEB_EXT_API_KEY='user:…'        # from https://addons.mozilla.org/developers/addon/api/key/
#   export WEB_EXT_API_SECRET='…'
#   ./sign.sh                               # unlisted (default)
#   ./sign.sh --listed                      # submit to the public listing instead
#
# The credentials are read from the environment by web-ext itself; this script never
# echoes them. The add-on id in the manifest is bound to the first AMO account that
# signs it, so use the account you mean to publish under.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
channel="unlisted"
for arg in "$@"; do
  case "$arg" in
    --listed)   channel="listed" ;;
    --unlisted) channel="unlisted" ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --listed or --unlisted)" >&2; exit 2 ;;
  esac
done

missing=()
[[ -n "${WEB_EXT_API_KEY:-}" ]]    || missing+=(WEB_EXT_API_KEY)
[[ -n "${WEB_EXT_API_SECRET:-}" ]] || missing+=(WEB_EXT_API_SECRET)
if (( ${#missing[@]} )); then
  cat >&2 <<MSG
sign.sh: ${missing[*]} not set.

Generate API credentials at https://addons.mozilla.org/developers/addon/api/key/
and export them in this shell before running:
    export WEB_EXT_API_KEY='user:…'
    export WEB_EXT_API_SECRET='…'
MSG
  exit 1
fi

command -v npx >/dev/null || { echo "sign.sh: npx (Node.js) is required" >&2; exit 1; }

"$here/build.sh" >/dev/null
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$here/dist/firefox/manifest.json")"
echo "signing ClarkReader $version ($channel)…"

out="$here/web-ext-artifacts"
npx --yes web-ext@8 sign \
  --source-dir "$here/dist/firefox" \
  --artifacts-dir "$out" \
  --channel "$channel" \
  --no-input

xpi="$(ls -t "$out"/*.xpi 2>/dev/null | head -1 || true)"
if [[ -n "$xpi" ]]; then
  echo
  echo "signed: $xpi"
  echo "Install it by opening that file in Firefox (File > Open File, or drag it onto a window)."
else
  echo "web-ext finished but no .xpi was produced; see its output above." >&2
  exit 1
fi
