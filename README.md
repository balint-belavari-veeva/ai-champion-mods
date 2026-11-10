# AI Champion mods for Claude Code

One install for a set of Claude Code mods. It also installs a status line that shows model, context fill and which Vault you are logged into.

## Install

```bash
bash install.sh
```

Then open a **new** Claude Code chat (mods load at chat start). Needs Claude Code 2.1.287+, `jq`, and the `vault` CLI (`vault upgrade` to get a build with `vault status`). `bash install.sh --no-statusline` skips the status line. If you installed Nate Herk's originals, the script removes them first.

## What you get

| Piece | What it does |
|---|---|
| Status line | `model  [bar] % ctx  vault: <Vaults this chat used>`. Most recent first and bold; green = sandbox, amber `⚠` = not provably a sandbox (treat as production). Built from the chat's own `vault` commands by a PostToolUse hook (`hooks/vault-track.py`), so two chats show their own Vaults. `(CLI now on X)` warns that another chat or terminal ran `vault switch` and commands without `--dns` will hit X. Red `vault: logged out` when the CLI session expired. Base status line by Patrick (Veeva AI Champion team). |
| Handoff, 1 click | The `handoff` button (or `/handoff`) writes a session handoff, saves it to `~/.claude/mods-data/cache-keeper/handoffs/`, clears the chat and sends the handoff as the first prompt. Before: 2 clicks. |
| Cache Keeper | Cache warm/cold band, `/keepwarm`, `/board` across chats, cold-send guard. |
| Goal Meter | Progress bar and ETA for `/goal`, `/goals`. |
| Recording Mode | `/rec` masks keys and personal data on screen while recording; `/rec off`. |
| Collision Guard | Asks before Claude edits a file another open chat changed in the last 30 minutes. |

## Why four plugins, not one

The engine allows one hooks module per plugin and refuses two modules that hook the same event. Merging would mean rewriting Nate's code, so this is one marketplace and one installer instead.

## Changes from Nate Herk's originals

See `CHANGES.md`. Based on Nate Herk's Claude Code mods, MIT licence, see `LICENSE`.

## Vault picker

The band's `vault` button (or `/vault`) lists the Vaults your login reaches. Click one to switch to it; if the session expired the same click logs you in to it (browser). Amber ⚠ Vaults (not provably a sandbox) ask for a second press. First login ever: press `l` (log in) and the CLI's browser picker takes over.
