# Install ai-champion-mods (instructions for Claude)

The user wants the ai-champion-mods plugins on THIS computer. Install from the GitHub marketplace, never a fork or a copy, so updates always follow the latest `main`. Run the commands yourself; ask only where noted.

1. Check prerequisites: `claude --version` (needs 2.1.292+), `jq`, `python3`. For the Vault plugins also `vault --version`. If something is missing, tell the user how to install it (`brew install jq`) and stop.
2. Remove the older bundle if present: `claude plugin list` shows anything `@nateherk-mods`; uninstall those (commands clash).
3. Add the marketplace: `claude plugin marketplace add balint-belavari-veeva/ai-champion-mods`
4. Ask the user which plugins they want (one line each):
   - `cache-keeper`: band above the prompt (context, cache state, cost)
   - `handoff`: one-click session handoff
   - `vault-login`: Vault picker / switch / login (needs the `vault` CLI)
   - `statusline`: terminal status line feeding the context bar
   - `veeva-vault-permissions`: Vault permission-tracing skill
5. Install `ai-champion` always, plus the chosen ones: `claude plugin install <name>@ai-champion-mods`
6. Tell the user to type `/ai-champion:setup` themselves (it only runs when typed; it turns on auto-update and the status line), then open a NEW chat. Mods only load at chat start.

If any command is rejected with a trust, policy or "not allowed" message, STOP. Do not work around it (no manual copying into `~/.claude`, no editing managed settings). Show the user the exact error and tell them to send it to the maintainer or their IT admin.

Update later: `claude plugin marketplace update ai-champion-mods`, then a new chat.
