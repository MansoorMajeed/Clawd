# {{PROJECT_NAME}}

{{PROJECT_DESCRIPTION}}

## Tech Stack

<!-- Updated during /plan-init -->
- **Language:** TBD
- **Build system:** Make (see Makefile)

## Build & Test

```bash
make check   # format + lint + test (the universal gate)
make test    # run test suite
make lint    # run linters
make fmt     # format code
make build   # build the project
make coverage # test coverage report
```

## Context Index

<!-- INDEX, not a dump. One line per file. Read only what's relevant. -->

### llm-context/
<!-- Updated via /update-docs after significant changes -->

*No context files yet. Created during /plan-init.*

### Key Directories
- `docs/plans/` — Implementation plans with `n2c:` annotations
- `docs/sessions/` — Session handoff files for context continuity
- `docs/adrs/` — Architecture Decision Records
- `docs/retros/` — Retrospective outputs
- `docs/research/` — Research artifacts (gitignored by default)

## Conventions

### Build Commands

Always use Makefile targets. NEVER run raw test/lint/build commands directly.

### Tests

Write tests alongside code, not after. They verify real behavior, not coverage numbers.
Don't mock what you can run. Prefer integration tests when the boundary is internal.

### Simplicity

Always pick the simplest approach. No abstractions for one-time operations. No defensive
code for impossible scenarios. No configurability nobody asked for.

### Commits

Small, frequent, one logical change per commit. Feature branches for all non-trivial work.

### Verification

Run `make check` before claiming anything works.

### Context Management

- llm-context/ is an index, not a dump. Read only what's relevant.
- After significant changes, run `/update-docs`.
- Write ADRs for significant architectural decisions.

## Workflow Commands

- `/research` — Research and distill into reference docs
- `/plan-init` — Initial project plan (architecture, MVP, vision)
- `/plan` — Plan a change (refactor, architecture, generic task)
- `/new-feature` — Plan and start a feature on a branch
- `/debug` — Systematic debugging (root cause first)
- `/review` — Code review from fresh context
- `/ship` — Run checks, version, changelog, push, PR
- `/retro` — Retrospective analysis
- `/save-session` — Save session for handoff
- `/update-docs` — Update llm-context/ and CLAUDE.md
- `/audit-context` — Full audit of docs vs codebase
