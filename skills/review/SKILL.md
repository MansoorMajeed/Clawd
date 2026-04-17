---
name: review
description: Code review from a fresh context. Run in a separate session — no knowledge of implementation decisions.
---

# Code Review

**You are reviewing code you did NOT write.** You have no context about implementation decisions. This is intentional — it prevents the "marking your own homework" problem.

## Setup

Identify the base branch and get the diff:

```bash
git log --oneline main..HEAD
git diff main...HEAD --stat
git diff main...HEAD
```

If there's a plan file referenced in recent commits or in `docs/plans/`, read it to understand the intended scope.

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

## Output Format

List findings with severity:

- **CRITICAL** — Must fix. Security issues, data loss risk, correctness bugs.
- **IMPORTANT** — Should fix. Logic errors, missing error handling, test gaps.
- **MINOR** — Consider fixing. Style, naming, minor simplification opportunities.

For each finding:
```
[SEVERITY] file:line — Description of the issue
  Suggestion: What to do instead
```

**Be direct and specific.** Don't soften feedback. The goal is to catch problems, not to be polite.
