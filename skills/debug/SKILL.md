---
name: debug
description: Systematic debugging — root cause first, then fix. No fixes without understanding why it's broken.
---

# Systematic Debugging

**Rule: No fixes without understanding the root cause.**

If you don't understand why it's broken, you can't reliably fix it. Guessing leads to whack-a-mole debugging where each fix reveals a new problem.

## Step 1: Reproduce

- Get the exact error message. Read it completely — don't skip past stack traces.
- Reproduce the bug consistently. If you can't reproduce it, you can't verify a fix.
- Write a failing test that demonstrates the bug, if possible. This becomes the regression test.

## Step 2: Investigate

- **Check observability first** (if debugging a running service):
  - Use the `research` tool to check Atlas/Lumen dashboards, Edgar traces, RADAR alerts, Chronos changes
  - Search Slack for similar issues others have hit
- **Trace backward** from the error to the source. Follow the data flow.
- **Check recent changes:** `git log --oneline -20 -- <affected files>`
- **Find working examples:** Is there similar code in the codebase that works? What's different?
- **Read the code**, don't assume. The bug is in what the code actually does, not what you think it does.

## Step 3: Hypothesize

Form a **specific, testable hypothesis:**

> "The bug is in [location] because [reason]. I can verify this by [test]."

Test it minimally — one change, one variable. Don't change multiple things at once.

- If the hypothesis is confirmed: proceed to Step 4.
- If wrong: form a new hypothesis with the new information.

## Step 4: Fix

- Fix the **root cause**, not the symptom.
- Write a **regression test** — it must fail without the fix and pass with the fix.
- Run `make check` — all tests must pass, not just the new one.
- **Minimal diff** — fewest files, fewest lines. Don't refactor while debugging.

## Escalation

**If 3 hypotheses fail: STOP.**

Don't guess again. This might be:
- An architectural issue, not a code bug
- A misunderstanding of the requirements
- A problem in a dependency or environment

Tell the user what you've tried and what you've learned. Ask for guidance.

## Red Flags (stop and reconsider)

- "Quick fix for now" — wrong instinct. Fix it right or don't fix it.
- "Just try changing X and see" — guessing, not debugging.
- Each fix reveals a new bug in a different place — you're at the wrong layer.
- The fix is bigger than the feature — step back and rethink.
