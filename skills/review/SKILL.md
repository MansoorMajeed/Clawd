---
name: review
description: Portable file-based code review from a fresh context. Use /skill:review; /review is the separate interactive review extension.
---

# Code Review

**You are reviewing code you did NOT write.** You have no context about implementation decisions. This is intentional — it prevents the "marking your own homework" problem.

## Setup

Establish what the user wants reviewed: a branch/commit range, a folder, or local staged/unstaged/untracked work. Resolve the actual base from the user's request or repository conventions (`origin/HEAD`, the branch's upstream, or the PR target). If it is ambiguous, ask; do not assume `main`, fetch, or check out remote work.

For a branch review, inspect committed work against the resolved base and include local changes when they are in scope:

```bash
git log --oneline "$BASE_REF"..HEAD
git diff "$BASE_REF"...HEAD --stat
git diff "$BASE_REF"...HEAD
git diff --cached
git diff
git ls-files --others --exclude-standard
```

Read in-scope untracked files directly; they do not appear in `git diff`.

If there's a plan file referenced in recent commits or in `.scratch/plans/`, read it to understand the intended scope.

## Review Checklist

### Check 1: Scope

Does the diff match the stated goal?

- **Scope creep:** Are there unrelated changes? Files modified that don't connect to the goal?
- **Missing pieces:** Are stated goals not addressed? Incomplete implementations?
- **Over-building:** Is there code for features or edge cases that weren't requested?

### Check 2: Critical Issues

Look for:
- SQL injection, command injection, XSS
- Race conditions or shared mutable state
- Unvalidated external input (user input, API responses)
- Hardcoded secrets, credentials, or API keys
- Missing error handling on external calls (network, file I/O, database)
- Resource leaks (unclosed connections, file handles)

### Check 3: Tests

- Are the tests testing **real behavior**? (Not just that a function was called)
- Would these tests catch a **regression**? (If the code broke, would the test fail?)
- Are there obvious **untested paths**? (Error cases, edge cases, empty inputs)
- Are tests **too tightly coupled** to implementation? (Will they break on a refactor?)

### Check 4: Simplicity

- Over-engineering? Abstractions that wrap a single implementation?
- Unnecessary configurability? Parameters nobody will change?
- Defensive code for impossible scenarios?
- Could any of this be simpler while achieving the same result?

### Check 5: Assumptions

- What assumptions does this code make about its inputs?
- What assumptions does it make about the environment?
- Are these documented or validated at the boundary?

### Check 6: Operational Safety

- Idempotency: is this safe to re-run?
- Graceful degradation: what happens when a dependency is down?
- On-call impact: does this change alert behavior or add noise?
- Incident resilience: would this break during a Sev 0?

## Output

### Severity levels

- **[P1]** — Must fix. Security issues, data loss risk, correctness bugs.
- **[P2]** — Should fix. Logic errors, missing error handling, test gaps, regressions.
- **[P3]** — Consider fixing. Style, naming, minor simplification opportunities.

### Format for each finding

```
### N. [P1/P2/P3] Short description — `file:line`

Explain the problem. Show the problematic code if helpful.

**Fix:** What to do instead (with code suggestion if applicable).
```

**Be direct and specific.** Don't soften feedback. The goal is to catch problems, not to be polite.

### Write the review file

Determine the current branch name:
```bash
BRANCH="$(git branch --show-current)"
SAFE_BRANCH="$(printf '%s' "$BRANCH" | sed 's/[^A-Za-z0-9._-]/-/g')"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
```

Write findings to `.scratch/reviews/${STAMP}-${SAFE_BRANCH}.md`. This filesystem-safe, timestamped name is the shared exchange contract with the `address-review` skill. If the user supplied a custom report path, use that instead and report it explicitly.

The file should contain:
1. A summary section (what was reviewed, branch, base)
2. All findings with the format above
3. A verdict: "Ship it", "Needs attention", or "Needs rework"
4. A "Human Reviewer Callouts" section for non-blocking items the human should be aware of (dependency changes, permission changes, etc.)

**Also present the findings in conversation** — the review file is for the implementer session, the conversation output is for the current session's user.
