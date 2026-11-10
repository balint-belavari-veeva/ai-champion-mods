#!/bin/bash
# AI Champion mods: one-command install.
#   bash install.sh            install (status line + 4 mods), replacing Nate Herk's originals
#   bash install.sh --no-statusline   mods only
# Safe to re-run. Open a NEW Claude Code chat afterwards (mods load at chat start).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
MODS="cache-keeper recording-mode goal-meter collision-guard"
SL="$HOME/.claude/statusline-command.sh"
SETTINGS="$HOME/.claude/settings.json"

command -v claude >/dev/null || { echo "claude CLI not found"; exit 1; }

if [ "$1" != "--no-statusline" ]; then
  command -v jq >/dev/null || { echo "jq is required for the status line (brew install jq)"; exit 1; }
  command -v vault >/dev/null || echo "note: 'vault' CLI not found: the status line will show 'vault: logged out'. Install it and run 'vault upgrade'."
  if [ -f "$SL" ] && ! cmp -s "$SL" "$HERE/statusline/statusline-command.sh"; then
    cp "$SL" "$SL.bak-$(date +%Y%m%d%H%M%S)"
    echo "backed up your existing status line"
  fi
  cp "$HERE/statusline/statusline-command.sh" "$SL"
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  if ! jq -e '.statusLine.command' "$SETTINGS" >/dev/null 2>&1; then
    tmp="$(mktemp)"
    jq '.statusLine = {"type":"command","command":"bash ~/.claude/statusline-command.sh"}' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
    echo "status line enabled in settings.json"
  fi
  # Per-chat Vault tracking: PostToolUse hook records which Vaults each chat uses
  mkdir -p "$HOME/.claude/hooks"
  cp "$HERE/hooks/vault-track.py" "$HOME/.claude/hooks/vault-track.py"
  if ! jq -e '[.hooks.PostToolUse[]?.hooks[]?.command] | any(test("vault-track.py"))' "$SETTINGS" >/dev/null 2>&1; then
    tmp="$(mktemp)"
    jq '.hooks.PostToolUse = ((.hooks.PostToolUse // []) + [{"matcher":"Bash","hooks":[{"type":"command","command":"python3 -I ~/.claude/hooks/vault-track.py"}]}])' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
    echo "vault tracking hook enabled in settings.json"
  fi
fi

# Remove Nate Herk's originals if present (same commands would clash)
for m in $MODS; do
  claude plugin uninstall "$m@nateherk-mods" >/dev/null 2>&1 && echo "removed $m@nateherk-mods" || true
done

claude plugin marketplace add "$HERE" >/dev/null 2>&1 || claude plugin marketplace update ai-champion-mods
for m in $MODS; do
  claude plugin install "$m@ai-champion-mods" >/dev/null 2>&1 || claude plugin update "$m@ai-champion-mods"
  echo "installed $m"
done
echo "Done. Open a new Claude Code chat to load the mods."
