---
name: plan-init
description: Initial project plan — architecture, MVP scope, and vision. Used once at the start of a project.
---

# Initial Project Plan

This is the foundational plan for the project. Used once at the start. Take your time here — the investment in planning pays for itself many times over in execution.

## Step 1: Load Context

Inspect the project first. Read its actual instruction files (`AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md`), existing architecture/docs if present, and relevant research in `.scratch/research/`. An empty project is valid; do not invent a documentation layout or build system before discussing it.

## Step 2: Discussion Phase

**No code in this phase.**

Have a real conversation with the user:
- What are we building? Who is it for?
- What's the simplest version that proves the idea?
- What are you unsure about?
- What assumptions are you making? (Challenge these.)
- What could go wrong?
- **Test your mental model:** What is your understanding of how the key technologies/platforms/services work? Is that understanding verified, or assumed from training data? The more work that depends on an assumption, the more it's worth confirming before building on it.

Don't rush this. Ask hard questions. Surface risks. This phase can take 30 minutes or several hours — that's fine. Bad assumptions caught here save days of wasted work.

## Step 3: Propose the Architecture Document

Once the direction is clear, propose the architecture content and its destination. Reuse the project's existing documentation convention; if none exists, agree on a path with the user. Keep the proposal in the scratch plan until approval rather than creating tracked files now.

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

This is the big picture vision. Subsequent plans can reference it after the approved implementation phase creates it.

## Step 4: Propose Project Setup

Identify the build/test/lint convention appropriate to the chosen stack and existing project. Prefer an existing check command; add a Makefile only if the user chooses that convention.

If a Makefile is selected, a useful pattern is component-specific sub-targets (`test-backend`, `test-frontend`) and aggregate targets (`test`, `lint`, `fmt`) combined by `make check`.

Propose updates to the project's actual instruction file (`AGENTS.md`, `CLAUDE.md`, or another established file) for the project name, description, stack, and commands. Do not write these tracked files before plan approval.

## Step 5: MVP Plan

Write the plan to `.scratch/plans/todo/YYYY-MM-DD-HHMMSS-mvp.md`. Include the agreed architecture and project-setup files in the first phase when they are needed; do not assume Makefile or CLAUDE.md.

```markdown
# MVP: [what we're building, in plain words]

## For you

[2-3 sentences: what we're building, for whom, and what we're NOT building]

**Needs your call**
1. [A real choice, with my recommendation]

**Assumptions**
2. [Only ones that would change the plan if wrong]

**Risks**
- [Only real ones]

---

## Execution detail (you don't need to review this)

[Approach, background, and minor defaults I chose]

## File Map
[Which files will be created/modified and their responsibilities]

## Tasks

Phase checklists: one `- [ ]` per phase, ticked `- [x]` when done and verified.

- [ ] **Phase 1: [description]**
  - Files: [exact paths]
  - Steps: [what to do, with test expectations where relevant]
  - Verification: [project's actual check command]
- [ ] **Phase 2: ...**
```

**Phase guidelines:**
- The "For you" section holds only what needs the user's judgment and fits on one screen. Number its items in one sequence so replies like "3: yes" are unambiguous.
- Each phase should be a small, logically complete chunk
- Include test expectations inline — write a failing regression first when behavior could regress; use applicable syntax/build/docs validation for genuinely non-behavioral work
- Include the project's actual verification command (`make check` when present)
- Be specific: exact file paths, exact function names, exact behavior

## Step 6: Annotation Loop

Post the "For you" items in chat with the same numbers. The user can reply by number in chat or add `n2c:` annotations in the file.

Then iterate:
1. Read their answers (and the file, if they annotated it)
2. Respond to each, then update the plan: write chat answers back into it and delete resolved annotations
3. Repeat until the user approves

**Watch for over-engineering:** If any task touches more than ~3 files or introduces a new abstraction layer, flag it. Ask: "Is this complexity necessary for the MVP?"

## Step 7: Hand Off Execution

Once approved, ask the user:
- Execute with `/skill:implement-plan` in this session?
- Or start a fresh context? (Recommended if this session is heavy from discussion)

`implement-plan` owns execution, checks, commits, review cadence, progress ticks, and moving the finished plan.
