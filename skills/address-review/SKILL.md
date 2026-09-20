---
name: address-review
description: Read and address code review findings from .scratch/reviews/ for the current branch.
---

# Address Review

## Step 1: Find the review

If the user supplied a review path, use it. Otherwise derive the same filesystem-safe branch identifier used by the `review` skill:

```bash
BRANCH="$(git branch --show-current)"
SAFE_BRANCH="$(printf '%s' "$BRANCH" | sed 's/[^A-Za-z0-9._-]/-/g')"
ls -1t .scratch/reviews/*-"$SAFE_BRANCH".md 2>/dev/null
```

If no review file exists, tell the user — there's nothing to address.
If multiple reports match, ask which one to use rather than guessing. Timestamped names make same-day reviews distinct.

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
3. If agreed: for a non-trivial fix not already covered by an approved plan, present the proposed scope and get approval before editing; trivial reversible fixes can proceed directly
4. Fix approved findings, writing a failing regression test first when behavior could regress, then run the project's check command (`make check` when present)
5. If disagreed: explain your reasoning to the user and ask for their call

Do NOT silently skip findings. Every finding gets a response.

## Step 4: Commit

After all findings are addressed, use `/skill:commit` to make atomic commits by concern. Do not collapse unrelated findings into one catch-all commit.

## Step 5: Update the review file

Append a section at the bottom of the review file:

```markdown
## Resolution (YYYY-MM-DD)

- Finding 1: Fixed — <what was done>
- Finding 2: Fixed — <what was done>
- Finding 3: Won't fix — <reason>
```

This closes the loop — the reviewer can check the resolution if needed.
