# AI Champion mods and skills for Claude Code

Claude Code add-ons for Veeva Services colleagues: a band above the prompt (context, cache state, cost), one-click handoff (own plugin), a Vault picker with click-to-log-in, plus a Vault permission-tracing skill. Not tied to any customer.

## Install (per colleague)

Needs Claude Code 2.1.292 or later (the mods need 2.1.287+), `jq`, `python3`, and for the Vault features the `vault` CLI (`vault upgrade` for a current build).

**Easiest:** tell Claude Code: *Install the mods by following https://raw.githubusercontent.com/balint-belavari-veeva/ai-champion-mods/main/INSTALL-FOR-CLAUDE.md*

**Or two commands** in a terminal (installs everything):

```
claude plugin marketplace add balint-belavari-veeva/ai-champion-mods
claude plugin install ai-champion@ai-champion-mods
```

Then in Claude Code, once: `/ai-champion:setup` (turns on automatic updates and the status line), and open a **new** chat (mods load at chat start; `/reload-plugins` is not enough).

`ai-champion` is the bundle: it pulls in every plugin in the table below. Want only some? Skip it and install just those with `claude plugin install <name>@ai-champion-mods`; turn on auto-update in `/plugin` → Marketplaces → `ai-champion-mods` (`/ai-champion:setup` comes with the bundle).

If you installed the older `nateherk-mods` bundle, uninstall it first: the commands clash.

## Updates

- **Automatic:** `/ai-champion:setup` sets `autoUpdate` for this marketplace in your settings. Claude Code checks in the background after your first message of a session (plus a random delay of up to 10 minutes). Without setup: `/plugin` → Marketplaces → `ai-champion-mods` → enable auto-update.
- **Not live.** A running chat keeps the version it loaded. Skills apply after `/reload-plugins` or a new chat. The mods only load at chat start, so they always need a **new chat**. This is the engine, not something the plugins can change.
- **Now:** `claude plugin marketplace update ai-champion-mods`, then a new chat.
- Plugins pin a `version`, so an update only arrives when the maintainer bumps it (logged in `CHANGES.md`).

## What you get

Each plugin works on its own. Each mod that draws above the prompt adds its own row, so installing more of them makes the area above the prompt taller.

| Plugin | What it does |
|---|---|
| `ai-champion` | Bundle: installs all the plugins below. Also `/ai-champion:setup` (auto-update; status line if `statusline` is installed). |
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
- Changelog: `CHANGES.md`.
