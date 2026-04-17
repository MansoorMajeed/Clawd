---
name: retro
description: Retrospective — analyze recent work patterns and outcomes from git history.
---

# Retrospective

Analyze recent work patterns to find what's working and what isn't. Default: last 14 days.

## Data Collection

Run these to gather data:

```bash
# Commits with stats
git log --since="14 days ago" --oneline --stat --no-merges

# Commit count per day
git log --since="14 days ago" --format="%ad" --date=short --no-merges | sort | uniq -c

# Most changed files (hotspots)
git log --since="14 days ago" --name-only --no-merges --format="" | sort | uniq -c | sort -rn | head -20

# Commit type breakdown
git log --since="14 days ago" --oneline --no-merges
```

## Analysis

### Commit Patterns
- Total commits, LOC added/removed
- Commits per day — any gaps? Bursts?
- Commit type breakdown: feat / fix / refactor / test / chore / docs
- **Fix ratio:** If fixes are more than 40% of commits, we're shipping too many bugs

### Hotspots
- Which files changed most? Frequent changes = instability or active development
- Are test files keeping pace with source files?

### Plans vs Reality
- Read recent plans from `docs/plans/`
- Did they survive contact with reality? What changed?
- Were estimates (number of tasks, scope) accurate?

### Tests
- Test LOC vs production LOC ratio
- Are tests being written alongside code or added later?

## Output

Write the retrospective to `docs/retros/YYYY-MM-DD-retro.md`:

```markdown
# Retrospective: YYYY-MM-DD

**Period:** [start date] to [end date]
**Commits:** N | **LOC:** +X / -Y | **Fix ratio:** Z%

## What Went Well
- [specific observations with evidence]

## What Didn't Go Well
- [specific observations with evidence]

## Hotspots
| File | Changes | Notes |
|------|---------|-------|
| ... | N | ... |

## Plans vs Reality
- [plan name]: [on track / deviated because...]

## Action Items
- [ ] [specific, actionable improvements for next period]
```

## Trend Comparison

If prior retros exist in `docs/retros/`, compare:
- Is the fix ratio improving or worsening?
- Are hotspots stabilizing or growing?
- Are action items from previous retros being addressed?

Be candid and specific. Use evidence from the git history, not vague impressions.
