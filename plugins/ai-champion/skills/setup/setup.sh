#!/bin/bash
# One-time (re-runnable) setup for the ai-champion-mods marketplace.
# 1) auto-update for the marketplace  2) status line, only if the statusline plugin is installed.
set -e
SETTINGS="$HOME/.claude/settings.json"
command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }
mkdir -p "$HOME/.claude"; [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
tmp="$(mktemp)"
jq '.extraKnownMarketplaces["ai-champion-mods"] = ((.extraKnownMarketplaces["ai-champion-mods"] // {"source":{"source":"github","repo":"balint-belavari-veeva/ai-champion-mods"}}) + {"autoUpdate":true})' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
echo "auto-update enabled for the ai-champion-mods marketplace"
SL="$(ls -d "$HOME"/.claude/plugins/cache/ai-champion-mods/statusline/*/bin/setup.sh 2>/dev/null | sort -V | tail -1)"
if [ -n "$SL" ]; then bash "$SL"; else echo "statusline plugin not installed: skipped the status line (install it, then re-run this)"; fi
echo "Done. Mods apply in a NEW chat."
