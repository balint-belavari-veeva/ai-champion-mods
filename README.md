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
| Status line | `model  [bar] % ctx  vault: <name>`. Red `vault: logged out` when the Vault CLI session expired. Status line by Patrick (Veeva AI Champion team). |
| Handoff, 1 click | The `handoff` button (or `/handoff`) writes a session handoff, saves it to `~/.claude/mods-data/cache-keeper/handoffs/`, clears the chat and sends the handoff as the first prompt. Before: 2 clicks. |
| Cache Keeper | Cache warm/cold band, `/keepwarm`, `/board` across chats, cold-send guard. |
| Goal Meter | Progress bar and ETA for `/goal`, `/goals`. |
| Recording Mode | `/rec` masks keys and personal data on screen while recording; `/rec off`. |
| Collision Guard | Asks before Claude edits a file another open chat changed in the last 30 minutes. |

## Why four plugins, not one

The engine allows one hooks module per plugin and refuses two modules that hook the same event. Merging would mean rewriting Nate's code, so this is one marketplace and one installer instead.

## Changes from Nate Herk's originals

See `CHANGES.md`. Based on Nate Herk's Claude Code mods, MIT licence, see `LICENSE`.
