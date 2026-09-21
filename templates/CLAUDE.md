# {{PROJECT_NAME}}

{{PROJECT_DESCRIPTION}}

## Tech Stack

<!-- Updated during /skill:plan-init -->
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

*Add entries for the documentation layout this project actually uses. Do not create `llm-context/` unless the project adopts it.*

### Key Directories
- `docs/adrs/` — Architecture Decision Records
- `.scratch/` — Ephemeral agent work (gitignored): `research/`, `plans/`, `reviews/`, `sessions/`

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

- Keep context indexes concise. Read only what's relevant.
- After significant changes, run `/skill:update-docs`.
- Write ADRs for significant architectural decisions.

## Workflow Skills

- `/skill:research` — Research and distill into reference docs
- `/skill:plan-init` — Initial project plan (architecture, MVP, vision)
- `/skill:plan` — Plan a feature or change and decide branch scope
- `/skill:implement-plan` — Execute an approved plan phase by phase
- `/skill:debug` — Systematic debugging (root cause first)
- `/skill:review` — Portable fresh-context review that writes findings to `.scratch/reviews/`
- `/skill:address-review` — Address findings from `.scratch/reviews/`
- `/skill:ship` — Run checks, version, changelog, push, and create a PR
- `/skill:save-session` — Save handoff state under `.scratch/sessions/`
- `/skill:update-docs` — Update project docs or run a full documentation audit
