#!/bin/bash
# Claude Code status line: model name + context usage progress bar

input=$(cat)

# The cache-keeper band (above the prompt) draws model + context now, so everything
# sits in one row. This script only hands it the numbers and prints nothing.
sid=$(echo "$input" | jq -r '.session_id // empty')
if [ -n "$sid" ]; then
  mkdir -p "$HOME/.claude/ctx-state"
  echo "$input" | jq -c '{model: (.model.display_name // "Claude"), pct: (.context_window.used_percentage // null)}' > "$HOME/.claude/ctx-state/$sid.json"
fi
exit 0

model=$(echo "$input" | jq -r '.model.display_name // "Claude"')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

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

  printf "\033[2m%s\033[0m  %s[%s]\033[0m %s%s%% ctx\033[0m\n" "$model" "$color" "$bar" "$color" "$pct"
else
  printf "\033[2m%s\033[0m\n" "$model"
fi
