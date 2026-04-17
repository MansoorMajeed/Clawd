---
name: plan-init
description: Initial project plan — architecture, MVP scope, and vision. Used once at the start of a project.
---

# Initial Project Plan

This is the foundational plan for the project. Used once at the start. Take your time here — the investment in planning pays for itself many times over in execution.

## Step 1: Load Context

Read all files in `llm-context/` and `docs/research/` first. Understand what research has already been done and what context exists.

## Step 2: Discussion Phase

**No code in this phase.**

Have a real conversation with the user:
- What are we building? Who is it for?
- What's the simplest version that proves the idea?
- What are you unsure about?
- What assumptions are you making? (Challenge these.)
- What could go wrong?

Don't rush this. Ask hard questions. Surface risks. This phase can take 30 minutes or several hours — that's fine. Bad assumptions caught here save days of wasted work.

## Step 3: Architecture Document

Once the direction is clear, write `llm-context/architecture.md`:

```markdown
# Architecture

## Overview
[One paragraph: what this system does and why]

## Key Components
[List each major component and its responsibility]

## Data Flow
[How data moves through the system]

## Tech Choices
[What we're using and why — language, frameworks, databases, etc.]

## MVP Scope
[What's IN scope for the first version]

## Deferred
[What we're explicitly NOT building yet, and why]
```

This is the big picture vision. All subsequent plans reference it.

## Step 4: Configure Makefile

Based on the tech stack decided in the architecture, configure the Makefile targets. The Makefile is the single source of truth for build/test/lint.

The pattern: component-specific sub-targets (`test-backend`, `test-frontend`), aggregate targets (`test`, `lint`, `fmt`) that combine them. The aggregate targets must always exist — that's what `make check` calls.

Also update CLAUDE.md with the project name, description, and tech stack.

## Step 5: MVP Plan

Write the plan to `docs/plans/YYYY-MM-DD-mvp.md`. The first task should always be "Configure Makefile and CLAUDE.md" if not done yet.

```markdown
# MVP Implementation Plan

**Goal:** [one sentence]
**Non-goals:** [what we're NOT building]
**Approach:** [2-3 sentences]

## File Map
[Which files will be created/modified and their responsibilities]

## Tasks

### Task 1: [Description]
**Files:** [exact paths]
**Steps:**
- [ ] Step description (with test expectations where relevant)
- [ ] Verification: `make check`

### Task 2: ...
```

**Task guidelines:**
- Each task should be completable in a few minutes
- Include test expectations inline — what to test, not a separate "add tests" phase
- Include verification steps (`make check`)
- Be specific: exact file paths, exact function names, exact behavior

## Step 6: Annotation Loop

Tell the user: "Review the plan and add `n2c:` annotations anywhere you have feedback."

Then iterate:
1. User adds `n2c:` comments to the plan file
2. You read them, respond, update the plan
3. Repeat until the user approves

**Watch for over-engineering:** If any task touches more than ~3 files or introduces a new abstraction layer, flag it. Ask: "Is this complexity necessary for the MVP?"

## Step 7: Execute or Fresh Start

Once approved, ask the user:
- Execute in this session?
- Or start a fresh context? (Recommended if this session is heavy from discussion)
