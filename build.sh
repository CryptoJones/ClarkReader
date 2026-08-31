#!/usr/bin/env bash
# Assemble a loadable extension directory per browser.
#
# The two differ only in the manifest: Chrome needs a service worker plus the
# offscreen permission, Firefox needs ordered background scripts and a gecko id.
# Everything else is shared, which is why none of the sources are ES modules —
# classic scripts are the one form both browsers' background contexts accept.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/extension"
out="$here/dist"

rm -rf "$out"
for browser in chrome firefox; do
  dest="$out/$browser"
  mkdir -p "$dest"
  # Everything but the manifests, then the right manifest as manifest.json.
  (cd "$src" && find . -type f ! -name 'manifest*.json' -exec cp --parents {} "$dest/" \;)
  if [[ "$browser" == chrome ]]; then
    cp "$src/manifest.json" "$dest/manifest.json"
  else
    cp "$src/manifest.firefox.json" "$dest/manifest.json"
  fi
  echo "built $dest"
done

cat <<'MSG'

Load them:
  Chrome   chrome://extensions -> Developer mode -> Load unpacked -> dist/chrome
  Firefox  about:debugging#/runtime/this-firefox -> Load Temporary Add-on
           -> pick dist/firefox/manifest.json
MSG
