---
name: research
description: Research a topic and distill into reference docs. Use 'deep' for parallel multi-source research.
---

# Research & Distillation

Your goal is to gather information and distill it into clean reference material — NOT to write code.

## When to persist vs. keep in context

**Persist to `.scratch/`** when:
- The research is for an ongoing feature/change that spans multiple sessions
- You queried multiple sources and synthesized a non-trivial answer
- The user explicitly asks to save the research
- Deep mode research (always persist)

**Keep in context only** when:
- Quick single-source lookup ("what's the API for X?")
- The answer is a few lines that the user will act on immediately

## How to research

1. **Scope it.** Understand what the user needs. Break complex topics into specific questions yourself — don't ask the user to do it.
2. **Dispatch.** Use available research tools (web search, docs, internal sources, subagents) to investigate.
   - **Default:** One call per question, sequential.
   - **Deep mode** (user says "deep"): Multiple sources per question, parallel where possible. Use subagents for fan-out.
3. **Synthesize.** Merge findings, flag contradictions, distill into a clean summary.

## Writing research files

Write to `.scratch/research-YYYY-MM-DD-<slug>.md`. The slug should be descriptive enough to scan in `ls`.

Keep the format simple:

```markdown
# <Title>
Date: YYYY-MM-DD
Context: <one-line — what feature/change this supports>

<distilled content — findings, code examples, source links, open questions>
```

No elaborate frontmatter. The value is in the content.

### Checking for existing research

If `.scratch/` exists and is non-empty, scan filenames before starting. Prior research may already answer part of the question — read relevant files to avoid re-deriving known information.

## Promoting research to permanent docs

After research is complete, ask: should any of this graduate to `llm-context/` or `docs/`?

- Cherry-pick the useful bits — don't copy the whole research file
- Research files in `.scratch/` are scratch; committed docs are curated
- Clean up `.scratch/` files when they've served their purpose

## Setup

`.scratch/` should be gitignored globally so it works in any repo without per-repo config:

```bash
echo '.scratch/' >> ~/.gitignore_global
git config --global core.excludesFile ~/.gitignore_global
```

## Reminders

- Research mode is research only. Do NOT start writing code.
- This context WILL be exhausted by research. That's expected — the distilled files survive for the next session.
