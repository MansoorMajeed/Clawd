---
name: address-review
description: Read and address code review findings from .scratch/review-*.md for the current branch.
---

# Address Review

## Step 1: Find the review

```bash
git branch --show-current
```

Look for the review file in `.scratch/`:
```bash
ls .scratch/review-*-$(git branch --show-current).md 2>/dev/null
```

If no review file exists, tell the user — there's nothing to address.

## Step 2: Read and summarize

Read the review file. Present a summary to the user:
- Total findings by severity (P1 / P2 / P3)
- Verdict from the reviewer
- One-line summary of each finding

## Step 3: Address findings

Work through findings **in priority order** (P1 first, then P2, then P3).

For each finding:
1. Read the referenced code
2. State whether you agree or disagree with the finding, and why
3. If agreed: fix it, add a test if the fix is behavioral, run `make check`
4. If disagreed: explain your reasoning to the user and ask for their call

Do NOT silently skip findings. Every finding gets a response.

## Step 4: Commit

After all findings are addressed, commit the fixes:
```
fix: address review findings — <brief summary of what changed>
```

## Step 5: Update the review file

Append a section at the bottom of the review file:

```markdown
## Resolution (YYYY-MM-DD)

- Finding 1: Fixed — <what was done>
- Finding 2: Fixed — <what was done>
- Finding 3: Won't fix — <reason>
```

This closes the loop — the reviewer can check the resolution if needed.
