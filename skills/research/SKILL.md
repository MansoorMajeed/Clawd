---
name: research
description: Research a topic and distill into reference docs. Use 'deep' for parallel multi-source research.
---

# Research & Distillation

You are in research mode. Your goal is to gather information and distill it into clean reference docs — NOT to write code.

## Step 1: Scope the Research

Ask the user what they need to learn. Break it into 3-5 specific research questions.
Be precise — "how does X work" is better than "learn about X".

## Step 2: Dispatch Research

Use available research tools (web search, documentation, internal sources if available) to investigate each question. Make a separate call per question.

- **Quick mode (default):** One research call per question.
- **Deep mode (if user says "deep"):** Check multiple sources per question for comprehensive coverage.

Return a **structured summary**, not raw output.
Include: key findings, source links, code examples if relevant, open questions.

## Step 3: Synthesize

Collect all results. Then:
1. Merge overlapping findings
2. Flag any contradictions between sources
3. Write distilled docs to `docs/research/YYYY-MM-DD-<topic>.md`

Each research doc should include:
- **Title and date**
- **Research questions** (what we set out to learn)
- **Key findings** (organized by question)
- **Source links** (where each finding came from)
- **Open questions** (what we still don't know)
- **Promotion candidates** (what might belong in `llm-context/`)

## Step 4: Promote to llm-context

Ask the user: which findings (if any) should be promoted to `llm-context/` as permanent project context?

For promoted content:
- Copy/move the relevant sections to `llm-context/<descriptive-name>.md`
- Update CLAUDE.md to reference the new file
- Keep the full research doc in `docs/research/` as the detailed record

## Important Reminders

- This context WILL be exhausted by research. That's fine — the goal is the distilled docs.
- The next phase (planning) starts with a fresh context and reads these docs.
- Do NOT start writing code. Research mode is research only.
