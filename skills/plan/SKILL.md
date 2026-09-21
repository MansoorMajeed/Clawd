---
name: plan
description: Plan a feature or change — branch-scoped feature, refactor, architecture update, or generic task.
---

# Plan a Change

For planning subsequent work after the initial MVP — features, refactors, architecture changes, or generic tasks.

## Step 1: Load Context

Read the project's actual instruction files and documentation layout first (`AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md`, plus relevant architecture/context docs if they exist). Then read relevant recent plans in `.scratch/plans/`. Do not require or create `llm-context/` unless this project uses it.

## Step 2: Discussion

What are we changing and why?

Key questions to discuss:
- Does this align with the architecture vision?
- If this changes documented architecture, include the project's existing architecture document in the plan
- What's the simplest way to achieve this?
- What could break?
- Should this work stay on the current branch or use a dedicated `feat/<kebab-case-name>` branch? Record the agreed branch scope in the plan; branch creation belongs to execution preflight.
- **Test your mental model:** What assumptions is this approach built on? Are you sure they're correct, or are you assuming? The more work that depends on an assumption, the more it's worth verifying before writing the plan.

## Step 3: Write the Plan

Write to the plans `todo/` directory — `.scratch/plans/todo/YYYY-MM-DD-HHMMSS-<slug>.md`:

```markdown
# [Topic] Plan

**Goal:** [one sentence]
**Approach:** [2-3 sentences]
**Branch scope:** [Current branch / feat/<name>]
**Architecture impact:** [None / Updates <actual architecture doc> because...]

## File Map
[Which files will be created/modified]

## Tasks

Plans are phase checklists: one `- [ ]` per phase, ticked `- [x]` when the phase is done and verified.

- [ ] **Phase 1: [description]**
  - Files: [exact paths]
  - Steps: [what to do — prose or sub-bullets, not separate checkboxes]
  - Verification: [project's actual check command]
- [ ] **Phase 2: [description]**
  - ...
```

**Guidelines:**
- Each phase: a logical chunk with specific files and a verification step
- Keep boxes phase-level (coarse-grained progress), not per-micro-step
- Include test expectations inline. Require a failing regression first when behavior could regress; for genuinely non-behavioral changes, name the applicable syntax/build/docs validation instead. Do not exempt TypeScript, configuration, or Markdown categorically.
- If the change touches more than ~5 files, consider splitting into multiple plans
- If it requires architecture changes, include the project's actual architecture documentation update as a phase

## Step 4: Annotation Loop

Tell the user to review and add `n2c:` annotations. When they say they've reviewed:
1. **Re-read the file** — annotations live in the file, not in chat
2. **Discuss each annotation** — respond to every `n2c:` comment, get alignment
3. **Update the plan** — iterate until approved

Do not skip the discussion step. The annotation loop is a conversation, not a rubber stamp.

## Step 5: Hand Off Execution

Once approved, invoke `/skill:implement-plan` or start a fresh session with the approved plan path. `implement-plan` owns branch setup, failing-first behavioral tests, verification, commits, review cadence, progress ticks, and moving the completed plan.
