#!/usr/bin/env bash
# Build a Claude plugin zip for upload to claude.ai (Customize > Plugins > Upload).
#
#   scripts/build-plugin.sh demo-helloworld
#
# 1. Copies plugins/shared/<name>.md into every skill as references/<app>.md, where
#    <app> is the plugin name after its first "-" (demo-helloworld ->
#    helloworld.md).
#    claude.ai gives skills no way to share a file, so each carries its own copy;
#    plugins/plugins.test.ts fails if a committed copy drifts from the source.
# 2. Validates with `claude plugin validate --strict`.
# 3. Zips the plugin directory to dist/<name>-<version>.zip.
set -euo pipefail

name="${1:?usage: scripts/build-plugin.sh <plugin-name>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
plugin="$root/plugins/$name"
shared="$root/plugins/shared/$name.md"

[ -d "$plugin" ] || { echo "no plugin at $plugin" >&2; exit 1; }
[ -f "$shared" ] || { echo "no shared reference at $shared" >&2; exit 1; }

for skill in "$plugin"/skills/*/; do
  mkdir -p "$skill/references"
  cp "$shared" "$skill/references/${name#*-}.md"
done

claude plugin validate --strict "$plugin"

version="$(node -p "require('$plugin/.claude-plugin/plugin.json').version")"
mkdir -p "$root/dist"
out="$root/dist/$name-$version.zip"
rm -f "$out"
# Python's zipfile rather than `zip`, which is not installed everywhere this runs.
python3 - "$plugin" "$out" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for d, dirs, files in os.walk(src):
        dirs[:] = sorted(x for x in dirs if x != "evals")
        for f in sorted(files):
            if f == ".DS_Store":
                continue
            path = os.path.join(d, f)
            z.write(path, os.path.relpath(path, src))
PY
echo "built $out"
