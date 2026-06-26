---
name: implement-plan
description: Drive a finished plan from .scratch/plans/todo/ to completion — implement phase by phase, review (quick=once at end, deep=per phase), commit, tick boxes, and notify. Trigger on "implement the plan", "execute the plan", "run the plan".
---

# Implement a Plan

Drive an approved plan in `.scratch/plans/todo/` to done. You execute **what the plan says** — you do not expand scope. The plan is a live ledger: tick each phase as you finish it.

## Step 1: Locate the plan

Look in `.scratch/plans/todo/`:
- If the user named one, use it.
- Else if exactly one exists, use it.
- Else list them and ask which.

**Read it fully before starting.** Re-read any `n2c:` annotations and any context/files it references.

## Step 2: Announce the mode

Two modes — pick from the user's phrasing, default **quick**:

- **quick** (default): implement all phases, then **one** review pass at the end, fix, done.
- **deep**: review after **each** phase, loop until clean. Use for risky or large changes (the user says "deep", "review each phase").

State the mode in your first message — e.g. *"Implementing `<plan>` in **quick** mode — review once at the end."* Write a status header near the top of the plan so it survives a context reset:

```
<!-- impl: quick | phase 1/N -->
```

## Step 3: Pre-flight

- Confirm a feature branch exists. If on `main`, create `feat/<slug>`.
- Confirm a clean working tree (or that pending changes belong to this plan).

## Step 4: Implement phase by phase

For each **unchecked** phase, in order:

1. Implement it. Write tests first where the plan changes behavior (TDD); skip tests for scaffolding/config/docs.
2. Run `make check` (or the project's check command).
3. Tick the box `- [x]` and bump the status header (`phase N/M`).
4. Commit atomically — one concern per commit, per the `commit` skill.

## Step 5: Review cadence (by mode)

- **quick:** after all phases are ticked, run the reviewer **once**.
- **deep:** after each phase, run the reviewer; loop implement → review → fix until clean before moving on.

Run the reviewer as a fresh-context sub-agent so it doesn't mark its own homework (`review` skill). Use a headless `subagent`. Address findings with the `address-review` skill (P1 → P2 → P3, respond to every finding), then re-check.

## Step 6: Finish

When all boxes are ticked **and** review is clean:

- Run `make check` one final time.
- Move the plan: `.scratch/plans/todo/<plan>.md` → `.scratch/plans/done/`.
- Tell the user it's complete (the `notify` extension fires a desktop notification on turn end).
- Offer `/ship` to create the PR.

## Resume protocol (after a context reset)

If you're unsure where you are:
1. Re-read the plan file. The **first unchecked box** is your current phase.
2. The status header (`<!-- impl: ... -->`) tells you the mode.
3. If the workflow itself is unclear, re-read this skill.

## Stop conditions

Stop and surface to the user — don't guess or expand scope — if:
- The plan can't be found, or is ambiguous about which to run.
- `make check` fails in a way the plan doesn't cover.
- The review loop isn't converging (same finding ~3×).
- A phase needs a decision the plan doesn't specify.
