---
name: setup
description: One-time setup for the ai-champion-mods marketplace. Turns on automatic updates for it. Use when the user says "enable auto-update for the mods" or runs /cache-keeper:setup.
disable-model-invocation: true
---

Run `bash "${CLAUDE_SKILL_DIR}/setup.sh"` and show its output. If it reports that jq is missing, tell the user to install it (`brew install jq`) and re-run. Do not edit settings by hand.
