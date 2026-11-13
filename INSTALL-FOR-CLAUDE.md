# Install ai-champion-mods (instructions for Claude)

The user wants the ai-champion-mods plugins on THIS computer. Install from the GitHub marketplace, never a fork or a copy, so updates always follow the latest `main`. Run the commands yourself; ask only where noted.

1. Check prerequisites: `claude --version` (needs 2.1.292+), `jq`, `python3`. For the Vault plugins also `vault --version`. If something is missing, tell the user how to install it (`brew install jq`) and stop.
2. Remove the older bundle if present: `claude plugin list` shows anything `@nateherk-mods`; uninstall those (commands clash).
3. Add the marketplace: `claude plugin marketplace add balint-belavari-veeva/ai-champion-mods`
4. Install the bundle: `claude plugin install ai-champion@ai-champion-mods`. It pulls in all the other plugins (cache-keeper, handoff, vault-login, statusline, veeva-vault-permissions). If the user asked for only some, install just those (`<name>@ai-champion-mods`) and skip `ai-champion`; then they enable auto-update in `/plugin` → Marketplaces → `ai-champion-mods`, and step 5 does not apply.
5. Tell the user to type `/ai-champion:setup` themselves (turns on auto-update and the status line), then open a NEW chat. Mods only load at chat start; `/reload-plugins` is not enough, say so.

If any command is rejected with a trust, policy or "not allowed" message, STOP. Do not work around it (no manual copying into `~/.claude`, no editing managed settings). Show the user the exact error and tell them to send it to the maintainer or their IT admin.

Update later: `claude plugin marketplace update ai-champion-mods`, then a new chat.
