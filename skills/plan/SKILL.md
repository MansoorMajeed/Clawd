---
name: plan
description: Plan a change — refactor, architecture update, or generic task.
---

# Plan a Change

For planning subsequent work after the initial MVP — refactors, architecture changes, or any non-feature task.

## Step 1: Load Context

Read `llm-context/architecture.md` first to understand the big picture. Then read relevant files in `llm-context/` and recent plans in `.scratch/`.

## Step 2: Discussion

What are we changing and why?

Key questions to discuss:
- Does this align with the architecture vision?
- If this changes the architecture, we need to update `llm-context/architecture.md` as part of the plan
- What's the simplest way to achieve this?
- What could break?
- **Test your mental model:** What assumptions is this approach built on? Are you sure they're correct, or are you assuming? The more work that depends on an assumption, the more it's worth verifying before writing the plan.

## Step 3: Write the Plan

Write to `.scratch/plan-YYYY-MM-DD-<topic>.md`:

```markdown
# [Topic] Plan

**Goal:** [one sentence]
**Approach:** [2-3 sentences]
**Architecture impact:** [None / Updates architecture.md because...]

## File Map
[Which files will be created/modified]

## Tasks

### Task 1: [Description]
**Files:** [exact paths]
**Steps:**
- [ ] Step description
- [ ] Test expectations
- [ ] Verification: `make check`
```

**Guidelines:**
- Each task: a few minutes of work, specific files, verification step
- Include test expectations inline
- If the change touches more than ~5 files, consider splitting into multiple plans
- If it requires architecture changes, include the `architecture.md` update as a task

## Step 4: Annotation Loop

Tell the user to review and add `n2c:` annotations. When they say they've reviewed:
1. **Re-read the file** — annotations live in the file, not in chat
2. **Discuss each annotation** — respond to every `n2c:` comment, get alignment
3. **Update the plan** — iterate until approved

Do not skip the discussion step. The annotation loop is a conversation, not a rubber stamp.

## Step 5: Execute

Once approved, proceed with execution. Write tests alongside code, run `make check` frequently, commit after each logical change.
