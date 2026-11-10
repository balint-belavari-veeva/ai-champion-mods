#!/bin/bash
# Claude Code status line: model name + context usage progress bar

input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // "Claude"')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

# Vault segment: the Vaults THIS chat has used (recorded by hooks/vault-track.py,
# keyed by session id). The vault CLI has one global "current" vault, cached 60s
# here only to flag a mismatch and a logged-out session.
session_id=$(echo "$input" | jq -r '.session_id // empty')
vcache="$HOME/.claude/.vault-status-cache"
if [ ! -f "$vcache" ] || [ -n "$(find "$vcache" -mmin +1 2>/dev/null)" ]; then
  ( out=$(vault status 2>/dev/null)
    if [ -n "$out" ]; then printf '%s\n' "$out" > "$vcache.tmp" && mv "$vcache.tmp" "$vcache"
    else printf 'LOGGED_OUT\n' > "$vcache"; fi ) >/dev/null 2>&1 &
fi
vault_seg=""
vfile="$HOME/.claude/vault-sessions/$session_id.json"
if [ -n "$session_id" ] && [ -f "$vfile" ]; then
  if [ -f "$vcache" ] && grep -q '^Vault:' "$vcache" && grep -q 'valid' "$vcache" && ! grep -qi 'expired\|invalid' "$vcache"; then
    cur_dns=$(sed -n 's/^DNS: *//p' "$vcache" | tr 'A-Z' 'a-z')
    items=""; last_dns=""
    # most recently used first, in bold
    while IFS=$'\t' read -r vdns vname; do
      [ -z "$vdns" ] && continue
      short=$(printf '%s' "$vname" | sed 's/ ([^)]*)$//')
      case "$vdns $(printf '%s' "$vname" | tr 'A-Z' 'a-z')" in
        sb-*|*sandbox*|*uat*|*sbx*|*template*|*demo*|*test*|*rebuild*|*-dev.*|*-dev-*|*sit-20*) c=$'\033[32m'; flag="" ;;
        *) c=$'\033[33m'; flag="⚠ " ;;   # not provably a sandbox: amber
      esac
      if [ -z "$last_dns" ]; then last_dns="$vdns"; short=$'\033[1m'"$short"; fi
      items="${items:+$items  }${c}${flag}${short}"$'\033[0m'
    done < <(jq -r 'reverse | .[] | [.dns, .name] | @tsv' "$vfile" 2>/dev/null)
    if [ -n "$items" ]; then
      vault_seg=$(printf '  vault: %s' "$items")
      # warn only if this chat's latest no-`--dns` vault differs from the CLI's current one
      cli_dns=$(jq -r '[.[] | select(.cli)] | last | .dns // empty' "$vfile" 2>/dev/null)
      if [ -n "$cur_dns" ] && [ -n "$cli_dns" ] && [ "$cur_dns" != "$cli_dns" ]; then
        vault_seg="$vault_seg"$(printf ' \033[33m(CLI now on %s)\033[0m' "${cur_dns%%.*}")
      fi
    fi
  else
    vault_seg=$(printf '  \033[31mvault: logged out\033[0m')
  fi
fi

bar_width=10

if [ -n "$used" ]; then
  filled=$(awk -v u="$used" -v w="$bar_width" 'BEGIN { v = int((u/100)*w + 0.5); if (v > w) v = w; if (v < 0) v = 0; print v }')
  empty=$((bar_width - filled))

  bar=""
  for ((i = 0; i < filled; i++)); do bar="${bar}#"; done
  for ((i = 0; i < empty; i++)); do bar="${bar}-"; done

  pct=$(awk -v u="$used" 'BEGIN { printf "%.0f", u }')

  # green <20%, orange 20-24%, red >=25%
  if [ "$pct" -lt 20 ]; then
    color=$'\033[32m'
  elif [ "$pct" -lt 25 ]; then
    color=$'\033[33m'
  else
    color=$'\033[31m'
  fi

  printf "\033[2m%s\033[0m  %s[%s]\033[0m %s%s%% ctx\033[0m%s\n" "$model" "$color" "$bar" "$color" "$pct" "$vault_seg"
else
  printf "\033[2m%s\033[0m%s\n" "$model" "$vault_seg"
fi
