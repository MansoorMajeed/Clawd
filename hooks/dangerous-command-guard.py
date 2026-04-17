#!/usr/bin/env python3
"""
PreToolUse hook: intercept Bash tool calls and flag dangerous commands.

Reads JSON from stdin (Claude Code hook input), splits composite commands,
checks each segment against dangerous patterns, and outputs a JSON decision.

On match:  exit 0 with JSON requesting user confirmation ("ask").
No match:  exit 0 with no output (silently allows the command).
"""

import json
import re
import sys


# Each entry: (compiled regex, human-readable description)
DANGEROUS_PATTERNS = [
    # -- File deletion --
    (re.compile(r"\brm\s+.*-[^\s]*r[^\s]*f"), "rm with -rf (recursive force delete)"),
    (re.compile(r"\brm\s+.*-[^\s]*f[^\s]*r"), "rm with -fr (recursive force delete)"),
    (re.compile(r"\brm\s+-rf\b"), "rm -rf"),
    (re.compile(r"\brm\s+-r\b"), "rm -r (recursive delete)"),
    (re.compile(r"\brm\s+(?!.*\.)(/|\s+~/?(\s|$))"), "rm on root or home directory"),

    # -- Git destructive --
    (re.compile(r"\bgit\s+reset\s+--hard\b"), "git reset --hard (destroys uncommitted changes)"),
    (re.compile(r"\bgit\s+push\s+.*--force\b"), "git push --force (rewrites remote history)"),
    (re.compile(r"\bgit\s+push\s+.*-f\b"), "git push -f (rewrites remote history)"),
    (re.compile(r"\bgit\s+clean\s+.*-f"), "git clean -f (deletes untracked files)"),
    (re.compile(r"\bgit\s+checkout\s+\.\s*$"), "git checkout . (discards all working tree changes)"),
    (re.compile(r"\bgit\s+restore\s+\.\s*$"), "git restore . (discards all working tree changes)"),
    (re.compile(r"\bgit\s+branch\s+.*-D\b"), "git branch -D (force-deletes branch)"),

    # -- Disk / device writes --
    (re.compile(r"\bdd\s+.*if="), "dd (raw disk write)"),
    (re.compile(r"\bmkfs\b"), "mkfs (format filesystem)"),
    (re.compile(r"\bfdisk\b"), "fdisk (partition table editor)"),
    (re.compile(r"\bparted\b"), "parted (partition editor)"),

    # -- Permission changes on system paths --
    (re.compile(r"\bchmod\s+.*-R\s+777\b"), "chmod -R 777 (world-writable recursive)"),
    (re.compile(r"\bchown\s+.*-R\s+.*\s+/(etc|usr|bin|sbin|lib|var)\b"),
     "chown -R on system path"),
]


def split_commands(command: str) -> list[str]:
    """Split a composite shell command into individual segments.

    Handles &&, ||, ;, and | while respecting quoted strings.
    This is intentionally simple -- not a full bash parser, but good enough
    for the patterns we care about.
    """
    segments = []
    current = []
    in_single_quote = False
    in_double_quote = False
    i = 0

    while i < len(command):
        ch = command[i]

        # Track quoting state
        if ch == "'" and not in_double_quote:
            in_single_quote = not in_single_quote
            current.append(ch)
            i += 1
            continue
        if ch == '"' and not in_single_quote:
            in_double_quote = not in_double_quote
            current.append(ch)
            i += 1
            continue

        # Inside quotes, everything is literal
        if in_single_quote or in_double_quote:
            current.append(ch)
            i += 1
            continue

        # Check for command separators
        if ch == ';' or ch == '|':
            segments.append(''.join(current))
            current = []
            # Skip || (treat as single separator)
            if ch == '|' and i + 1 < len(command) and command[i + 1] == '|':
                i += 1
            i += 1
            continue
        if ch == '&' and i + 1 < len(command) and command[i + 1] == '&':
            segments.append(''.join(current))
            current = []
            i += 2
            continue

        current.append(ch)
        i += 1

    # Don't forget the last segment
    if current:
        segments.append(''.join(current))

    return [s.strip() for s in segments if s.strip()]


def strip_quoted_content(segment: str) -> str:
    """Remove content inside quotes so patterns in string literals don't trigger.

    Replaces quoted regions with empty strings, preserving the command structure
    outside of quotes. Handles single quotes, double quotes, and $'...' ANSI-C
    quoting. Also strips heredoc bodies (<<'EOF'...EOF, <<"EOF"...EOF, <<EOF...EOF).
    """
    # First strip heredoc bodies: everything from <<[']WORD['] to WORD on its own line
    segment = re.sub(
        r"<<-?\s*['\"]?(\w+)['\"]?.*?\n.*?\1",
        lambda m: f"<<{m.group(1)}",
        segment,
        flags=re.DOTALL,
    )
    result = []
    i = 0
    while i < len(segment):
        ch = segment[i]
        # ANSI-C quoting $'...'
        if ch == '$' and i + 1 < len(segment) and segment[i + 1] == "'":
            i += 2
            while i < len(segment) and segment[i] != "'":
                if segment[i] == '\\' and i + 1 < len(segment):
                    i += 2
                else:
                    i += 1
            i += 1  # skip closing quote
            continue
        # Single-quoted string
        if ch == "'":
            i += 1
            while i < len(segment) and segment[i] != "'":
                i += 1
            i += 1  # skip closing quote
            continue
        # Double-quoted string
        if ch == '"':
            i += 1
            while i < len(segment) and segment[i] != '"':
                if segment[i] == '\\' and i + 1 < len(segment):
                    i += 2
                else:
                    i += 1
            i += 1  # skip closing quote
            continue
        result.append(ch)
        i += 1
    return ''.join(result)


def check_command(command: str) -> tuple[bool, str] | None:
    """Check a full command string for dangerous patterns.

    Returns (matched: bool, description: str) or None if safe.
    Strips quoted content first so patterns inside string literals
    (e.g. git commit messages, echo arguments) don't trigger.
    """
    segments = split_commands(command)
    for segment in segments:
        stripped = strip_quoted_content(segment)
        for pattern, description in DANGEROUS_PATTERNS:
            if pattern.search(stripped):
                return (True, description)
    return None


def main():
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        # Can't parse input -- let it through rather than blocking everything
        sys.exit(0)

    command = hook_input.get("tool_input", {}).get("command", "")
    if not command:
        sys.exit(0)

    result = check_command(command)
    if result is None:
        # Safe command -- allow silently
        sys.exit(0)

    _, description = result

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "ask",
            "permissionDecisionReason": (
                f"\033[1;31m🚨🔥 DANGEROUS COMMAND DETECTED 🔥🚨\033[0m\n"
                f"\033[1;33m⚠️  {description} ⚠️\033[0m"
            ),
            "additionalContext": (
                f"SAFETY REMINDER: This command involves {description}. "
                "If this is an irreversible action on a device, embedded system, or "
                "production environment, invoke the irreversible-action-checklist skill "
                "and verify a rollback path exists before proceeding."
            ),
        },
    }
    json.dump(output, sys.stdout)
    sys.exit(0)


if __name__ == "__main__":
    main()
