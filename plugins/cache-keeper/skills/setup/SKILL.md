---
name: setup
description: One-time setup for the cache-keeper mods. Enables the status line that feeds the context bar and turns on auto-update for the bi-skills marketplace. Use when the user says "set up the mods", "enable the context bar", or runs /cache-keeper:setup.
disable-model-invocation: true
---

Run `bash "${CLAUDE_PLUGIN_ROOT}/bin/setup.sh"` and show its output. If it reports that jq is missing, tell the user to install it (`brew install jq`) and re-run. Afterwards tell the user to open a NEW chat; do not edit settings by hand.
