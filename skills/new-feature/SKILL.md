---
name: new-feature
description: Plan and start a new feature on a branch.
---

# New Feature

Start a scoped feature — plan it, branch it, build it.

## Step 1: Understand Context

Read `llm-context/architecture.md` to understand the current system.

If this feature doesn't fit within the existing architecture, tell the user and suggest using `/plan` instead (which handles architecture changes).

## Step 2: Create Branch

```bash
git checkout -b feat/<feature-name>
```

If the feature name has spaces, convert to kebab-case.

## Step 3: Scoped Plan

Write a focused plan to `.scratch/plans/todo/YYYY-MM-DD-HHMMSS-feat-<feature-name>.md`:

```markdown
# Feature: <feature-name>

**Goal:** [one sentence]
**Components touched:** [which existing parts of the system this affects]

## Tasks

Phase checklists: one `- [ ]` per phase, ticked `- [x]` when done and verified.

- [ ] **Phase 1: [description]**
  - Files: [exact paths]
  - Steps: [what to do, with test expectations]
  - Verification: `make check`
- [ ] **Phase 2: ...**
```

**This is NOT a full architecture discussion.** Keep it focused:
- Goal in one sentence
- Which existing components this touches
- Tasks with files, verification steps, test expectations
- A feature should be shippable in one session if possible

## Step 4: Annotation Loop

Tell the user to review and add `n2c:` annotations. Iterate until approved.

## Step 5: Execute

Once approved, build the feature:
- Write tests alongside code (not after)
- Run `make check` after each significant change
- Commit after each logical piece of work
- Keep commits small and descriptive
- Tick each phase `- [x]` as you finish it — the first unchecked box is where to resume after a context reset

## Step 6: Finish

When the feature is complete:
- Run `make check` one final time
- Move the plan to `.scratch/plans/done/`
- Suggest `/ship` to create a PR
- Or suggest `/review` first if the user wants a fresh-context review
