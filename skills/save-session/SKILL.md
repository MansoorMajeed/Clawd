---
name: save-session
description: Save current session state for handoff to a new context.
---

# Save Session

Snapshot the current session state so a new context can pick up exactly where we left off.

## Gather State

1. Current branch: `git branch --show-current`
2. Recent commits this session: `git log --oneline -10`
3. Uncommitted changes: `git status --short`
4. What we were working on (from conversation context)
5. Any open questions or blockers

## Write Session File

Write to `docs/sessions/YYYY-MM-DD-<topic>.md`:

```markdown
# Session: <topic>

**Date:** YYYY-MM-DD
**Branch:** <current branch>

## Current State

[What's done, what's in progress, what's blocked. Be specific — file names, function names, what works and what doesn't.]

## Key Decisions

[Decisions made during this session and why. Brief — reference ADRs for big ones.]

## Open Questions

[Things that are unresolved. Include enough context that a fresh session can understand the question without re-reading the whole codebase.]

## Next Steps

[Exactly what the next session should do first. Be specific enough that someone with no context can start immediately.]

1. First, do X
2. Then, do Y
3. Watch out for Z
```

## Before Saving

Ask the user to review the session file. They may want to add or correct details that aren't visible in the code.

Tell the user: "Start your next session by reading this file: `docs/sessions/YYYY-MM-DD-<topic>.md`"
