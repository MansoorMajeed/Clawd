---
name: tmux
description: "Remote control tmux sessions for interactive CLIs (python, gdb, etc.) by sending keystrokes and scraping pane output."
license: Vibecoded
---

# tmux Skill

Use tmux as a programmable terminal multiplexer for interactive work. Works on Linux and macOS with stock tmux; avoid custom config by using a private socket.

## When to use tmux instead of Bash tool

Use tmux (not the Bash tool) when:
- **Commands need `sudo`** -- tmux lets the user type the password in the attached terminal
- **Long-running processes** that need monitoring (builds, downloads, VMs)
- **Interactive programs** needing TTY input (python, gdb, ssh, screen)

## Quickstart (isolated socket)

**CRITICAL: Resolve the socket path to an absolute path in your FIRST Bash call.** The `$TMPDIR` variable can be empty or wrong between separate Bash tool invocations.

```bash
# Resolve socket path ONCE and share its directory with the discovery helper
SOCKET_ROOT="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || printf '%s\n' "${TMPDIR:-/tmp}")"
export CLAUDE_TMUX_SOCKET_DIR="${SOCKET_ROOT%/}/claude-tmux-sockets"
SOCKET="$CLAUDE_TMUX_SOCKET_DIR/claude.sock"
mkdir -p "$CLAUDE_TMUX_SOCKET_DIR"
echo "SOCKET=$SOCKET"  # save this -- reuse in ALL subsequent calls
```

Then create and use sessions:
```bash
SESSION=claude-python
tmux -S "$SOCKET" new -d -s "$SESSION" -n shell
# NOTE: Window may be :0 or :1 depending on shell/config. Verify with list-windows.
tmux -S "$SOCKET" list-windows -t "$SESSION"  # check actual window number
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- 'python3 -q' Enter
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -200  # watch output
tmux -S "$SOCKET" kill-session -t "$SESSION"                   # clean up
```

After starting a session ALWAYS tell the user how to monitor the session by giving them a command to copy paste:

```
To monitor this session yourself:
  tmux -S "$SOCKET" attach -t claude-lldb

Or to capture the output once:
  tmux -S "$SOCKET" capture-pane -p -J -t claude-lldb:0.0 -S -200
```

This must ALWAYS be printed right after a session was started and once again at the end of the tool loop. But the earlier you send it, the happier the user will be.

## Socket convention

- Agents MUST set `CLAUDE_TMUX_SOCKET_DIR` as shown above, place sockets under it, and use `tmux -S "$SOCKET"`. The explicit slash produces `/tmp/claude-tmux-sockets/claude.sock` on Linux and keeps `find-sessions.sh --all` on the same directory.
- Default socket path: `SOCKET="$CLAUDE_TMUX_SOCKET_DIR/claude.sock"`.
- Resolve and print the absolute path once. Separate Bash tool invocations do not preserve shell variables, so prefix later calls with the recorded `SOCKET=/absolute/path` (and `CLAUDE_TMUX_SOCKET_DIR=/absolute/directory` for `--all`) rather than assuming the variables remain set.

## Targeting panes and naming

- Target format: `{session}:{window}.{pane}`. Keep names short (e.g., `claude-py`, `claude-gdb`).
- **Window numbering varies**: Some shells (fish) or tmux configs start at window 1, not 0. Always verify with `list-windows` before targeting:
  ```bash
  tmux -S "$SOCKET" list-windows -t "$SESSION"  # check actual window number
  ```
- Use `-S "$SOCKET"` consistently to stay on the private socket path. If you need user config, drop `-f /dev/null`; otherwise `-f /dev/null` gives a clean config.
- Inspect: `tmux -S "$SOCKET" list-sessions`, `tmux -S "$SOCKET" list-panes -a`.

## Reconnecting to existing sessions

After any disruption (crash, context loss, session resume), always re-discover before sending:
```bash
tmux -S "$SOCKET" list-sessions                    # verify session exists
tmux -S "$SOCKET" list-windows -t "$SESSION"       # get actual window number
# THEN use the window number from list-windows output
tmux -S "$SOCKET" send-keys -t "$SESSION":1.0 ...  # use verified number
```

Never assume the window number from memory -- always verify.

## Finding sessions

- List sessions on your active socket with metadata: `./scripts/find-sessions.sh -S "$SOCKET"`; add `-q partial-name` to filter.
- Scan all sockets under the shared directory: `./scripts/find-sessions.sh --all` (uses `CLAUDE_TMUX_SOCKET_DIR` or `${TMPDIR:-/tmp}/claude-tmux-sockets`).

## Sending input safely

- **Without `-l`**: `tmux ... send-keys -t target -- 'command text' Enter` -- `Enter` is a tmux key name, sent as a keypress.
- **With `-l`** (literal mode): `tmux ... send-keys -t target -l 'text'` -- ALL args after `-l` are literal text. **`Enter` after `-l` sends the string "Enter", NOT a keypress.** To include a newline, use `$'text\n'`:
  ```bash
  tmux -S "$SOCKET" send-keys -t target -l $'echo hello\n'
  ```
- To send control keys (cannot use `-l`): `tmux ... send-keys -t target C-c`, `C-d`, `C-z`, `Escape`, etc.

### CRITICAL: Never send multi-line code via send-keys

**NEVER send multi-line source via send-keys.** Write it to a file first. A single properly quoted execution command may contain shell metacharacters, as in the completion examples below.

**Always write multiline source with the file-writing or Bash tool first, then send only the execution command:**
```bash
# After creating /tmp/myscript.py outside tmux, execute it with a unique marker.
MARKER="pi-done-$(date +%s)-$$-$RANDOM"
tmux -S "$SOCKET" send-keys -t target -- "python3 /tmp/myscript.py; command_status=\$?; printf '\n%s:%s\n' '$MARKER' \"\$command_status\"" Enter
./scripts/wait-for-text.sh -S "$SOCKET" -t target -m "$MARKER" -T 30
```

## MANDATORY: Waiting for commands -- use sentinels, NEVER blind sleep

**NEVER use `sleep N && capture-pane`.** This wastes time (waits the full N even if the command finishes in 0.5s) and can miss output (if the command takes longer than N).

**ALWAYS append a fresh marker with the command's exit status and poll with `wait-for-text.sh`:**

```bash
# 1. Generate a unique marker and send the command with status output appended
MARKER="pi-done-$(date +%s)-$$-$RANDOM"
tmux -S "$SOCKET" send-keys -t target -- "apt install -y foo; command_status=\$?; printf '\n%s:%s\n' '$MARKER' \"\$command_status\"" Enter

# 2. Poll for an exact '<marker>:<exit-status>' output line
./scripts/wait-for-text.sh -S "$SOCKET" -t target -m "$MARKER" -T 120

# 3. NOW read the output
tmux -S "$SOCKET" capture-pane -p -J -t target -S -200
```

Why this is mandatory:
- `sleep 30` wastes 29.5s if the command finishes in 0.5s
- `sleep 10` misses output if the command takes 11s
- A unique marker cannot match the echoed command or stale output; completion mode returns 0 only for status 0 and reports a nonzero command status as failure

For **interactive prompts** (Python `>>>`, gdb `(gdb)`), use `wait-for-text.sh` with the prompt regex instead of a sentinel.

## Watching output

- Capture recent history (joined lines to avoid wrapping artifacts): `tmux -S "$SOCKET" capture-pane -p -J -t target -S -200`.
- **Always capture and verify output after every send-keys.** Never assume a command succeeded just because send-keys returned.
- For continuous monitoring, poll with the helper script instead of `tmux wait-for` (which does not watch pane output).
- You can also temporarily attach to observe: `tmux -S "$SOCKET" attach -t "$SESSION"`; detach with `Ctrl+b d`.
- When giving instructions to a user, **explicitly print a copy/paste monitor command** alongside the action -- don't assume they remembered the command.

## Spawning Processes

Some special rules for processes:

- when asked to debug, use lldb by default
- when starting a python interactive shell, always set the `PYTHON_BASIC_REPL=1` environment variable. This is very important as the non-basic console interferes with your send-keys.

## Interactive tool recipes

- **Python REPL**: `tmux ... send-keys -- 'PYTHON_BASIC_REPL=1 python3 -q' Enter`; wait for `^>>>`; send code with `-l`; interrupt with `C-c`.
- **gdb**: `tmux ... send-keys -- 'gdb --quiet ./a.out' Enter`; disable paging `tmux ... send-keys -- 'set pagination off' Enter`; break with `C-c`; issue `bt`, `info locals`, etc.; exit via `quit` then confirm `y`.
- **Menu-driven CLIs** (gcalcli edit, interactive installers, etc.): Send single-character menu options, use `wait-for-text.sh` between sends, capture output to verify state:
  ```bash
  tmux -S "$SOCKET" send-keys -t target -- 'r' Enter
  ./scripts/wait-for-text.sh -S "$SOCKET" -t target -p 'Enter value' -T 5
  tmux -S "$SOCKET" send-keys -t target -- '1560' Enter
  ./scripts/wait-for-text.sh -S "$SOCKET" -t target -p 'saved' -T 5
  ```
- **Other TTY apps** (ipdb, psql, mysql, node, bash): same pattern -- start the program, poll for its prompt, then send literal text and Enter.

## Cleanup

- Kill a session when done: `tmux -S "$SOCKET" kill-session -t "$SESSION"`.
- Kill all sessions on a socket: `tmux -S "$SOCKET" list-sessions -F '#{session_name}' | xargs -r -n1 tmux -S "$SOCKET" kill-session -t`.
- Remove everything on the private socket: `tmux -S "$SOCKET" kill-server`.

## Helper: wait-for-text.sh

`./scripts/wait-for-text.sh` polls a pane for a regex (or fixed string) with a timeout. Works on Linux/macOS with bash + tmux + grep.

```bash
./scripts/wait-for-text.sh -S "$SOCKET" -t session:0.0 (-p 'pattern' [-F] | -m "$MARKER") [-T 20] [-i 0.5] [-l 2000]
```

- `-S`/`--socket` tmux socket path (passed as `tmux -S`)
- `-t`/`--target` pane target (required)
- `-p`/`--pattern` regex to match (required); add `-F` for fixed string
- `-m`/`--completion-marker` exact completion line prefix; waits for `<marker>:<exit-status>` and returns that status as success/failure
- `-T` timeout seconds (integer, default 15)
- `-i` poll interval seconds (default 0.5)
- `-l` history lines to search from the pane (integer, default 1000)
- Pattern mode exits 0 on first match and 1 on timeout. Completion mode exits 0 only for a reported status of 0; a nonzero status or timeout exits 1. Failures print diagnostics to stderr.
