---
name: setup
description: One-time setup for all ai-champion-mods plugins. Turns on automatic updates for the marketplace and, if the statusline plugin is installed, enables its status line. Use when the user says "set up the mods", "enable auto-update for the mods", or runs /ai-champion:setup.
disable-model-invocation: true
---

Run `bash "${CLAUDE_SKILL_DIR}/setup.sh"` and show its output. If it reports that jq is missing, tell the user to install it (`brew install jq`) and re-run. Afterwards tell the user to open a NEW chat. Do not edit settings by hand.
