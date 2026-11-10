#!/bin/bash
# Claude Code status line: model name + context usage progress bar

input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // "Claude"')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

# Vault DX login status, cached 60s, refreshed in background
vcache="$HOME/.claude/.vault-status-cache"
if [ ! -f "$vcache" ] || [ -n "$(find "$vcache" -mmin +1 2>/dev/null)" ]; then
  ( out=$(vault status 2>/dev/null)
    if [ -n "$out" ]; then printf '%s\n' "$out" > "$vcache.tmp" && mv "$vcache.tmp" "$vcache"
    else printf 'LOGGED_OUT\n' > "$vcache"; fi ) >/dev/null 2>&1 &
fi
vault_seg=""
if [ -f "$vcache" ]; then
  if grep -q '^Vault:' "$vcache" && grep -q 'valid' "$vcache" && ! grep -qi 'expired\|invalid' "$vcache"; then
    vname=$(sed -n 's/^Vault: *\(.*\) (ID [0-9]*)$/\1/p' "$vcache")
    vault_seg=$(printf '  \033[32mvault: %s\033[0m' "$vname")
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
