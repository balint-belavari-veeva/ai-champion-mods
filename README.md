# AI Champion mods and skills for Claude Code

Claude Code add-ons for Veeva Services colleagues: a band above the prompt (context, cache state, cost), one-click handoff, a Vault picker with click-to-log-in, plus a Vault permission-tracing skill. Not tied to any customer. Based on Nate Herk's Claude Code mods (MIT, see `LICENSE`).

## Install (per colleague)

Needs Claude Code 2.1.292 or later (the mods need 2.1.287+), read access to this GitHub repo (private), `jq`, `python3`, and for the Vault features the `vault` CLI (`vault upgrade` for a current build).

1. Git credentials, once (auto-update needs them too; `GITHUB_TOKEN` alone does not work): `gh auth login` then `gh auth setup-git`, or an SSH key.
2. In a terminal:
   ```
   claude plugin marketplace add balint-belavari-veeva/ai-champion-mods
   claude plugin install cache-keeper@ai-champion-mods
   ```
   Add any of the others the same way: `veeva-vault-permissions`, `goal-meter`, `recording-mode`, `collision-guard`. (In Claude Code: `/plugin install cache-keeper --marketplace balint-belavari-veeva/ai-champion-mods`. If the syntax is rejected, check `claude plugin install --help` on your build.)
3. Open Claude Code and run `/cache-keeper:setup` once. It enables the status line that feeds the context bar and turns on automatic updates for this marketplace.
4. Open a **new** chat (mods load at chat start).

If you installed Nate Herk's originals (`@nateherk-mods`), uninstall them first: the commands clash.

## Updates

- **Automatic:** `/cache-keeper:setup` sets `autoUpdate` for this marketplace in your settings. Claude Code checks in the background after your first message of a session (plus a random delay of up to 10 minutes). Without setup: `/plugin` → Marketplaces → `ai-champion-mods` → enable auto-update.
- **Not live.** A running chat keeps the version it loaded. Skills apply after `/reload-plugins` or a new chat. The mods only load at chat start, so they always need a **new chat**. This is the engine, not something the plugins can change.
- **Now:** `claude plugin marketplace update ai-champion-mods`, then a new chat.
- Plugins pin a `version`, so an update only arrives when the maintainer bumps it (logged in `CHANGES.md`).

## What you get

| Plugin | What it does |
|---|---|
| `cache-keeper` | Band: model + context bar, cache warm/cold, `/keepwarm`, session cost and rewrite cost, cold-send guard. `agents` button (`/ck-agents`): each agent of the chat with status, context, cost. `handoff` button (`/handoff`): writes a handoff, clears the chat and continues in a fresh one, one click. `vault` button (`/vault`): lists the Vaults your login reaches; one click switches, or logs you in (browser) if the session expired. Amber ⚠ Vaults (not provably a sandbox) need a second press. |
| `veeva-vault-permissions` | Skill: can user X read/edit/create/delete an object or field, and which security profile or permission set grants it. Read-only, through the signed-in `vault` CLI. |
| `goal-meter` | Progress bar and ETA for `/goal`, `/goals`. |
| `recording-mode` | `/rec` masks keys and personal data on screen while recording; `/rec off`. |
| `collision-guard` | Asks before Claude edits a file another open chat changed in the last 30 minutes. |

Status line: it prints nothing itself, it only hands the context % to the band (terminal). VS Code falls back to the chat's own usage. If you already have a status line, setup leaves it alone: call `~/.claude/statusline-command.sh` from yours or the terminal context bar stays empty.

## Maintainer notes

- Bump the plugin's `version` in `.claude-plugin/plugin.json` and log it in `CHANGES.md` for every release, or colleagues get no update.
- `bash install.sh` installs from this folder (local development; refreshes the status line script). Validate with `claude plugin validate --strict plugins/<name>`.
- Four mod plugins, not one: the engine allows one hooks module per plugin and refuses two modules that hook the same event.
- Publishing: `git subtree push --prefix=projects/ai-champion-mods <remote> main` from `claude-home`.
- Changes from Nate's originals: `CHANGES.md`.
