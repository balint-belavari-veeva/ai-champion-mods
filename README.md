# AI Champion mods and skills for Claude Code

Claude Code add-ons for Veeva Services colleagues: a band above the prompt (context, cache state, cost), one-click handoff (own plugin), a Vault picker with click-to-log-in, plus a Vault permission-tracing skill. Not tied to any customer. Based on Nate Herk's Claude Code mods (MIT, see `LICENSE`).

## Install (per colleague)

Needs Claude Code 2.1.292 or later (the mods need 2.1.287+), read access to this GitHub repo (private), `jq`, `python3`, and for the Vault features the `vault` CLI (`vault upgrade` for a current build).

1. Git credentials, once (auto-update needs them too; `GITHUB_TOKEN` alone does not work): `gh auth login` then `gh auth setup-git`, or an SSH key.
2. In a terminal:
   ```
   claude plugin marketplace add balint-belavari-veeva/ai-champion-mods
   claude plugin install ai-champion@ai-champion-mods
   claude plugin install cache-keeper@ai-champion-mods
   claude plugin install handoff@ai-champion-mods
   claude plugin install vault-login@ai-champion-mods
   claude plugin install statusline@ai-champion-mods
   claude plugin install veeva-vault-permissions@ai-champion-mods
   ```
   `ai-champion` is the setup plugin (install it always); pick only the others you want (see the table). (In Claude Code: `/plugin install cache-keeper --marketplace balint-belavari-veeva/ai-champion-mods`. If the syntax is rejected, check `claude plugin install --help` on your build.)
3. In Claude Code, once, after installing the plugins you want: `/ai-champion:setup`. It turns on automatic updates for all of them and, if you installed `statusline`, enables the status line (re-run it after installing `statusline` later).
4. Open a **new** chat (mods load at chat start).

If you installed Nate Herk's originals (`@nateherk-mods`), uninstall them first: the commands clash.

## Updates

- **Automatic:** `/ai-champion:setup` sets `autoUpdate` for this marketplace in your settings. Claude Code checks in the background after your first message of a session (plus a random delay of up to 10 minutes). Without setup: `/plugin` → Marketplaces → `ai-champion-mods` → enable auto-update.
- **Not live.** A running chat keeps the version it loaded. Skills apply after `/reload-plugins` or a new chat. The mods only load at chat start, so they always need a **new chat**. This is the engine, not something the plugins can change.
- **Now:** `claude plugin marketplace update ai-champion-mods`, then a new chat.
- Plugins pin a `version`, so an update only arrives when the maintainer bumps it (logged in `CHANGES.md`).

## What you get

Each plugin works on its own. Each mod that draws above the prompt adds its own row, so installing more of them makes the area above the prompt taller.

| Plugin | What it does |
|---|---|
| `ai-champion` | Setup only: `/ai-champion:setup` (auto-update; status line if `statusline` is installed). |
| `cache-keeper` | Band: model + context bar (needs `statusline` in the terminal), cache warm/cold, `/keepwarm`, session cost and rewrite cost, cold-send guard. `agents` button (`/ck-agents`): each agent of the chat with status, context, cost. |
| `handoff` | `handoff` button (`/handoff`): writes a session handoff, clears the chat and continues in a fresh one, one click. Handoffs are saved under `~/.claude/mods-data/handoff/handoffs/`. Includes the `session-handoff` skill. |
| `vault-login` | Needs the `vault` CLI. `vault` button (`/vault`) and a row showing the CLI's current Vault (green sandbox, yellow production). One click switches the CLI to a Vault, or logs you in (browser) if the session expired. Amber ⚠ Vaults (not provably a sandbox) need a second press. Tracks which Vaults each chat used. |
| `statusline` | Terminal status line script that hands the context % to the `cache-keeper` band. Without it the terminal context bar is empty (VS Code falls back to the chat's own usage). If you already have a status line, setup leaves it alone: call `~/.claude/statusline-command.sh` from yours. |
| `veeva-vault-permissions` | Skill: can user X read/edit/create/delete an object or field, and which security profile or permission set grants it. Read-only, through the signed-in `vault` CLI. |

## Maintainer notes

- Bump the plugin's `version` in `.claude-plugin/plugin.json` and log it in `CHANGES.md` for every release, or colleagues get no update.
- `bash install.sh` installs from this folder (local development; refreshes the status line script). Validate with `claude plugin validate --strict plugins/<name>`.
- One hooks module per plugin (engine rule), so `cache-keeper`, `handoff` and `vault-login` are separate plugins. Several plugins can hook the same event and each draws its own row above the prompt.
- Publishing: `git subtree push --prefix=projects/ai-champion/ai-champion-mods <remote> main` from `claude-home`.
- Changes from Nate's originals: `CHANGES.md`.
