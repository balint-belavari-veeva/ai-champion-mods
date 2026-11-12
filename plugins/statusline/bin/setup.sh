#!/bin/bash
# One-time (re-runnable) setup for the statusline plugin: enables the status line that feeds the
# context bar. Needs jq. Safe to re-run; refreshes the copied script after plugin updates.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SL="$HOME/.claude/statusline-command.sh"; SETTINGS="$HOME/.claude/settings.json"
command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }
mkdir -p "$HOME/.claude"
if [ -f "$SL" ] && ! cmp -s "$SL" "$HERE/statusline.sh"; then cp "$SL" "$SL.bak-$(date +%Y%m%d%H%M%S)"; echo "backed up your existing status line script"; fi
cp "$HERE/statusline.sh" "$SL"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
if ! jq -e '.statusLine.command' "$SETTINGS" >/dev/null 2>&1; then
  tmp="$(mktemp)"; jq '.statusLine = {"type":"command","command":"bash ~/.claude/statusline-command.sh"}' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  echo "status line enabled"
else echo "status line already set in settings.json (left as is; it must call ~/.claude/statusline-command.sh)"; fi
echo "Done. Open a NEW chat."
