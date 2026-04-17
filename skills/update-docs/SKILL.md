---
name: update-docs
description: Update llm-context/ and CLAUDE.md to reflect recent code changes.
---

# Update Documentation

Keep llm-context/ and CLAUDE.md current with the actual codebase. Run this after significant changes — feature completion, refactors, architecture shifts.

## Step 1: Identify What Changed

```bash
git log --oneline -20 --no-merges
git diff HEAD~5 --stat
```

Read the recent commits to understand what areas of the codebase were affected.

## Step 2: Audit llm-context/

For each file in `llm-context/`:
1. Read the file
2. Check if the code it describes still matches reality
3. If it's stale — update it with current state
4. If the file covers something that no longer exists — ask the user before deleting

**Do NOT read every source file to verify.** Check the files that were touched in recent commits. If a commit changed `pkg/auth/`, and `llm-context/auth.md` exists, verify that file. Don't audit unrelated context files.

## Step 3: Check for Missing Context

Look at what was recently added or changed:
- New major component with no llm-context file? Create one.
- Significant architectural shift? Update `llm-context/architecture.md`
- New integration or dependency? Might deserve its own context file.

**Each llm-context file should:**
- Cover one clear topic
- Be self-contained
- Focus on the "why" and "how" — not repeat what's obvious from the code
- Stay under ~200 lines. If longer, split it.

## Step 4: Update the CLAUDE.md Index

Update the `## Context Index` section in CLAUDE.md. One line per file. Description should be enough to decide "do I need this for my task?"

## Step 5: Prune

Remove context that:
- Duplicates what's obvious from the code or tests
- Describes features that were removed
- Is too granular (function-level docs belong in code comments)

Less context that's accurate > more context that's stale.

## What NOT to Do

- Don't rewrite llm-context files from scratch unless they're fundamentally wrong
- Don't add context for trivial changes
- Don't make CLAUDE.md longer. If anything, make it shorter.
- Don't update docs/research/ — those are frozen snapshots
