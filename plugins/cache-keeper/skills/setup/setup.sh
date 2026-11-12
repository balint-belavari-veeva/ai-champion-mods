#!/bin/bash
# Turns on auto-update for the ai-champion-mods marketplace in the user's settings. Safe to re-run.
set -e
SETTINGS="$HOME/.claude/settings.json"
command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }
mkdir -p "$HOME/.claude"; [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
tmp="$(mktemp)"
jq '.extraKnownMarketplaces["ai-champion-mods"] = ((.extraKnownMarketplaces["ai-champion-mods"] // {"source":{"source":"github","repo":"balint-belavari-veeva/ai-champion-mods"}}) + {"autoUpdate":true})' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
echo "auto-update enabled for the ai-champion-mods marketplace. Mods apply in a NEW chat."
