---
name: audit-context
description: Full audit of llm-context/, CLAUDE.md, and README against actual codebase.
---

# Full Context Audit

Deep audit of all documentation against the actual codebase. Unlike `/update-docs` (which checks only recently changed files), this audits everything.

## Step 1: Map the Codebase

Scan the project and build a structural map:
- Top-level directories and their purpose
- Key source files (entry points, main modules, config)
- Test directories and their structure
- Total rough file count

## Step 2: Audit llm-context Files

For each file in `llm-context/`:
1. Read the llm-context file
2. Read the actual source files it describes
3. Verdict:
   - **CURRENT** — file accurately describes the code
   - **STALE** — specific lines/sections that don't match reality (list them)
   - **DEAD** — describes code/components that no longer exist
   - **BLOATED** — over ~200 lines or covers too many topics (suggest split)

## Step 3: Audit CLAUDE.md

Check the CLAUDE.md index section:
- Every file in `llm-context/` is listed in the index (no missing entries)
- No index entries for files that don't exist (no ghost entries)
- Descriptions are accurate one-liners (not stale summaries)
- Tech stack section matches reality
- Build commands match the actual Makefile

## Step 4: Audit README

If `README.md` exists:
- Does the project description match what the code actually does?
- Are setup/install instructions still valid?
- Are referenced commands/APIs still present?
- Any sections describing removed features?

Don't rewrite the README. Flag specific lines that are wrong.

## Step 5: Report and Fix

Present findings:

```markdown
## Audit Results

### llm-context/
| File | Status | Issue |
|------|--------|-------|
| architecture.md | STALE | Section on auth describes JWT but code uses sessions |
| database.md | CURRENT | — |

### CLAUDE.md
- [ ] Index missing: llm-context/caching.md (added last week)
- [ ] Tech stack says "PostgreSQL" but code uses SQLite

### README.md
- [ ] Install section references `npm install` but project uses `make build`
```

Ask the user: fix all issues now, or pick specific ones?

For each fix:
- Update the file with current information
- Keep changes minimal — correct what's wrong, don't rewrite
- For DEAD files, ask before deleting
- For BLOATED files, propose a split and ask before executing

## Step 6: Commit

```bash
git add llm-context/ CLAUDE.md README.md
git commit -m "docs: audit and update project context"
```
