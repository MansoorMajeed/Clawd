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

Write a focused plan to `.scratch/plans/YYYY-MM-DD-feat-<feature-name>.md`:

```markdown
# Feature: <feature-name>

**Goal:** [one sentence]
**Components touched:** [which existing parts of the system this affects]

## Tasks

### Task 1: [Description]
**Files:** [exact paths]
**Steps:**
- [ ] What to do
- [ ] Test expectations
- [ ] Verification: `make check`
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

## Step 6: Finish

When the feature is complete:
- Run `make check` one final time
- Suggest `/ship` to create a PR
- Or suggest `/review` first if the user wants a fresh-context review
