#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: wait-for-text.sh -t target (-p pattern | -m marker) [options]

Poll a tmux pane for text and exit when found.

Options:
  -S, --socket    tmux socket path (passed as tmux -S)
  -t, --target    tmux target (session:window.pane), required
  -p, --pattern   regex pattern to look for, required
  -m, --completion-marker
                  wait for an exact '<marker>:<exit-status>' output line
  -F, --fixed     treat pattern as a fixed string (grep -F)
  -T, --timeout   seconds to wait (integer, default: 15)
  -i, --interval  poll interval in seconds (default: 0.5)
  -l, --lines     number of history lines to inspect (integer, default: 1000)
  -h, --help      show this help
USAGE
}

socket=""
target=""
pattern=""
completion_marker=""
grep_flag="-E"
timeout=15
interval=0.5
lines=1000

while [[ $# -gt 0 ]]; do
  case "$1" in
    -S|--socket)   socket="${2-}"; shift 2 ;;
    -t|--target)   target="${2-}"; shift 2 ;;
    -p|--pattern)  pattern="${2-}"; shift 2 ;;
    -m|--completion-marker) completion_marker="${2-}"; shift 2 ;;
    -F|--fixed)    grep_flag="-F"; shift ;;
    -T|--timeout)  timeout="${2-}"; shift 2 ;;
    -i|--interval) interval="${2-}"; shift 2 ;;
    -l|--lines)    lines="${2-}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$target" || ( -z "$pattern" && -z "$completion_marker" ) ]]; then
  echo "target and either pattern or completion marker are required" >&2
  usage
  exit 1
fi

if [[ -n "$pattern" && -n "$completion_marker" ]]; then
  echo "use either pattern or completion marker, not both" >&2
  exit 1
fi

if [[ "$completion_marker" == *:* || "$completion_marker" == *$'\n'* || "$completion_marker" == *$'\r'* ]]; then
  echo "completion marker must not contain a colon or newline" >&2
  exit 1
fi

if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
  echo "timeout must be an integer number of seconds" >&2
  exit 1
fi

if ! [[ "$lines" =~ ^[0-9]+$ ]]; then
  echo "lines must be an integer" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH" >&2
  exit 1
fi

# End time in epoch seconds (integer, good enough for polling)
start_epoch=$(date +%s)
deadline=$((start_epoch + timeout))

while true; do
  # -J joins wrapped lines, -S (capture-pane) uses negative index to read last N lines
  tmux_cmd=(tmux)
  [[ -n "$socket" ]] && tmux_cmd+=(-S "$socket")
  pane_text="$("${tmux_cmd[@]}" capture-pane -p -J -t "$target" -S "-${lines}" 2>/dev/null || true)"

  if [[ -n "$completion_marker" ]]; then
    completion_status=""
    while IFS= read -r pane_line; do
      pane_line="${pane_line%$'\r'}"
      if [[ "$pane_line" == "$completion_marker:"* ]]; then
        candidate_status="${pane_line#"$completion_marker:"}"
        if [[ "$candidate_status" =~ ^[0-9]+$ ]]; then
          completion_status="$candidate_status"
        fi
      fi
    done <<< "$pane_text"

    if [[ -n "$completion_status" ]]; then
      if [[ "$completion_status" == "0" ]]; then
        exit 0
      fi
      echo "Command completed with status $completion_status" >&2
      exit 1
    fi
  elif printf '%s\n' "$pane_text" | grep $grep_flag -- "$pattern" >/dev/null 2>&1; then
    exit 0
  fi

  now=$(date +%s)
  if (( now >= deadline )); then
    if [[ -n "$completion_marker" ]]; then
      echo "Timed out after ${timeout}s waiting for completion marker: $completion_marker" >&2
    else
      echo "Timed out after ${timeout}s waiting for pattern: $pattern" >&2
    fi
    echo "Last ${lines} lines from $target:" >&2
    printf '%s\n' "$pane_text" >&2
    exit 1
  fi

  sleep "$interval"
done
