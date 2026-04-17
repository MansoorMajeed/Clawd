#!/bin/bash
# Prepend intercepted-commands to PATH for the entire session.
# Shim scripts in intercepted-commands/ shadow pip, python, poetry
# and redirect to uv equivalents.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INTERCEPTED_DIR="$SCRIPT_DIR/intercepted-commands"

if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo "export PATH=\"$INTERCEPTED_DIR:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
