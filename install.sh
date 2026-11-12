#!/bin/bash
# AI Champion mods: one-command local install.
#   bash install.sh            install (status line + cache-keeper + vault-login), replacing Nate Herk's originals
#   bash install.sh --no-statusline   mods only
# Safe to re-run. Open a NEW Claude Code chat afterwards (mods load at chat start).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
MODS="cache-keeper vault-login handoff statusline"
SL="$HOME/.claude/statusline-command.sh"
SETTINGS="$HOME/.claude/settings.json"

command -v claude >/dev/null || { echo "claude CLI not found"; exit 1; }

if [ "$1" != "--no-statusline" ]; then
  command -v jq >/dev/null || { echo "jq is required for the status line (brew install jq)"; exit 1; }
  command -v vault >/dev/null || echo "note: 'vault' CLI not found: the status line will show 'vault: logged out'. Install it and run 'vault upgrade'."
  if [ -f "$SL" ] && ! cmp -s "$SL" "$HERE/plugins/statusline/bin/statusline.sh"; then
    cp "$SL" "$SL.bak-$(date +%Y%m%d%H%M%S)"
    echo "backed up your existing status line"
  fi
  cp "$HERE/plugins/statusline/bin/statusline.sh" "$SL"
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  if ! jq -e '.statusLine.command' "$SETTINGS" >/dev/null 2>&1; then
    tmp="$(mktemp)"
    jq '.statusLine = {"type":"command","command":"bash ~/.claude/statusline-command.sh"}' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
    echo "status line enabled in settings.json"
  fi
  # The Vault tracking hook (vault-track.py) now ships inside the vault-login plugin; nothing to register here.
  # If an older install registered ~/.claude/hooks/vault-track.py in settings.json, remove that entry (it would run twice).
fi

# Remove Nate Herk's originals if present (same commands would clash)
for m in $MODS; do
  claude plugin uninstall "$m@nateherk-mods" >/dev/null 2>&1 && echo "removed $m@nateherk-mods" || true
done

claude plugin marketplace add "$HERE" >/dev/null 2>&1 || true
# Always refresh: re-adding an existing marketplace does not re-read it, so updates would silently stay on the old version
claude plugin marketplace update ai-champion-mods >/dev/null 2>&1 || true
for m in $MODS; do
  # install is a silent no-op when already installed, so always follow with update (the one that applies a new version)
  claude plugin install "$m@ai-champion-mods" >/dev/null 2>&1 || true
  claude plugin update "$m@ai-champion-mods" >/dev/null 2>&1 || true
  echo "installed $m"
done
echo "Done. Open a new Claude Code chat to load the mods."
