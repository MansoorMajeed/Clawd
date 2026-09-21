---
name: update-docs
description: Update project documentation after scoped changes, or run a full documentation audit against the codebase.
---

# Update Documentation

Keep the project's established documentation current with the actual codebase. Use the default incremental mode after significant changes; use **full audit mode** when the user asks for a full audit or invokes this skill with `full`/`audit`.

## Step 1: Discover Conventions and Scope

Read the project's actual instruction files (`AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md`) and inventory its existing documentation. This may include `README.md`, `docs/`, `llm-context/`, architecture records, or another project-specific layout. Do not require or create a template layout the project does not use.

Establish the change scope from the user's requested range, an approved plan, the branch base, and any in-scope local changes. Ask if the range is ambiguous; do not use an arbitrary commit count. Identify the project's real check command from its instructions/build files, preferring `make check` when present.

## Incremental Mode

### Step 2: Inspect Affected Documentation

Read the code and documentation within the established change scope:

1. Identify changed components and behavior.
2. Find existing docs that describe them.
3. Compare those docs with the current implementation.
4. Identify significant new components, architecture changes, dependencies, commands, or removed features that need documentation.

Do not audit unrelated source files in incremental mode.

### Step 3: Propose Minimal Updates

Report the specific stale, missing, dead, or misleading sections and propose the smallest corrections. Follow the project's conventions for indexes and instruction files; update an index only if one exists.

Ask for approval before non-trivial edits unless the updates are already covered by an approved plan. Ask before deleting dead documents or splitting broad ones.

## Full Audit Mode

### Step 2: Map the Codebase and Documentation

Build a structural map of top-level components, entry points, configuration, tests, and existing documentation. Then compare every in-scope permanent documentation file with the source it describes.

Classify findings:

- **CURRENT** — accurately describes the code
- **STALE** — specific content no longer matches
- **DEAD** — describes code or features that no longer exist
- **BLOATED** — mixes too many topics or obscures useful context; propose a split
- **MISSING** — important behavior or setup has no documentation in the established layout

Check project instruction files for accurate stack, commands, and documentation indexes when those sections exist. Check `README.md` for current description, setup, commands/APIs, and removed features. Do not rewrite correct prose merely for style.

### Step 3: Report Before Editing

Present findings by file with concrete locations and proposed minimal fixes. Ask whether to fix all findings or a selected subset. For DEAD files, ask before deletion; for BLOATED files, propose the split and ask before executing.

## Apply and Verify

For approved changes:

1. Correct only the inaccurate or missing material; preserve useful existing structure and wording.
2. Keep source changes out of this workflow unless separately approved.
3. Validate links, examples, syntax, generated docs, and the project check command as applicable. Markdown and TypeScript documentation/configuration are not blanket test exemptions when they affect behavior or tooling.
4. Review the diff so unrelated pre-existing edits are not included.
5. If the user requested a commit, stage only the approved hunks/files and use `/skill:commit`; never broadly stage optional directories or unrelated changes.

## What NOT to Do

- Don't assume `llm-context/`, a CLAUDE.md index, README, Makefile, or any other template file exists.
- Don't rewrite documentation from scratch unless it is fundamentally wrong and the user approved that scope.
- Don't add permanent documentation for trivial implementation details.
- Don't update frozen research snapshots unless explicitly requested.
