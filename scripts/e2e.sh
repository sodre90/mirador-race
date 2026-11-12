#!/usr/bin/env bash
# Runs the plugin's e2e specs against a Mirador test host, with Mirador's own Playwright, so the specs share it with
# Mirador's e2e helpers. MIRADOR_DIR names Mirador's checkout; by default it sits next to this one.
# The specs get a copy of the plugin in a temp folder: Mirador's plugins folder links the copy, so the owner's own
# Mirador, which links this checkout, never runs a test's build.
# Usage: scripts/e2e.sh [Playwright arguments]
set -euo pipefail

plugin=$(cd "$(dirname "$0")/.." && pwd)
mirador=$(cd "${MIRADOR_DIR:-$plugin/../visualized-claude-sessions}" && pwd)
copy=$(mktemp -d "${TMPDIR:-/tmp}/mirador-race-e2e.XXXXXX")
trap 'rm -rf "$copy"' EXIT

existingOwnFiles() { while IFS= read -r -d '' file; do if [[ $file != */ && -e $file ]]; then printf '%s\0' "$file"; fi; done; }
(cd "$plugin" && git ls-files -z --cached --others --exclude-standard -- ':(exclude)node_modules' ':(exclude)e2e/node_modules' | existingOwnFiles | tar --null -T - -cf -) | tar -xf - -C "$copy"
ln -s "$plugin/node_modules" "$copy/node_modules"
ln -sfn "$mirador/node_modules" "$plugin/e2e/node_modules"
cd "$mirador"
MIRADOR_DIR="$mirador" RACE_PLUGIN_DIR="$copy" bunx playwright test -c "$plugin/e2e/playwright.config.ts" "$@"
