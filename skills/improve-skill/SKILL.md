---
name: improve-skill
description: "Analyze coding agent session transcripts to improve existing skills or create new ones. Use when asked to improve a skill based on a session, or extract a new skill from session history."
---

# Improve Skill

This skill helps analyze coding agent sessions to improve or create skills. It works with Claude Code, Pi, and Codex session files.

## Quick Start

Extract the current session and generate an improvement prompt:

```bash
# Resolve this from the loaded skill location; keep the shell cwd at the project.
EXTRACTOR=/absolute/path/to/improve-skill/scripts/extract-session.js
node "$EXTRACTOR"
```

Use the script's absolute path so cwd-based fallback discovery still refers to the project.

## Session Extraction

The `extract-session.js` script finds and parses session files from any of the three agents:

```bash
# Auto-detect (uses most recent session for current working directory)
node "$EXTRACTOR"

# Specify agent type
node "$EXTRACTOR" --agent claude
node "$EXTRACTOR" --agent pi
node "$EXTRACTOR" --agent codex

# Specify a different working directory
node "$EXTRACTOR" --cwd /path/to/project

# Use a specific session file
node "$EXTRACTOR" --agent pi /path/to/session.jsonl
```

Without arguments, the extractor uses the current `PI_SESSION_FILE` when available; otherwise it labels and selects the newest matching fallback across supported agents. An explicit path and `--agent` take precedence. Pi extraction follows the active branch and preserves tool calls, compaction summaries, and branch summaries.

**Session file locations:**
- **Claude Code**: `~/.claude/projects/<encoded-cwd>/*.jsonl`
- **Pi**: `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl`
- **Codex**: `~/.codex/sessions/YYYY/MM/DD/*.jsonl`

## Workflow: Improve an Existing Skill

When asked to improve a skill based on a session:

1. **Extract the session transcript:**
   ```bash
   node "$EXTRACTOR" > /tmp/session-transcript.txt
   ```

2. **Find the existing skill's authoritative source.** Pi can load skills from `~/.pi/agent/skills/`, `~/.agents/skills/`, project `.pi/skills/` or `.agents/skills/`, package `skills/`/`pi.skills` paths, settings paths, and explicit `--skill` paths. Prefer the authoring checkout over an installer-managed package clone, which package reconciliation may reset. If several copies exist or the intended scope is unclear, ask before editing.

3. **Generate an improvement prompt** for a new session:

```
═══════════════════════════════════════════════════════════════════════════════
COPY THE FOLLOWING PROMPT INTO A NEW AGENT SESSION:
═══════════════════════════════════════════════════════════════════════════════

I need to improve the "<skill-name>" skill based on a session where I used it.

First, read the current skill at: <path-to-skill>

Then analyze this session transcript to understand:
- Where I struggled to use the skill correctly
- What information was missing from the skill
- What examples would have helped
- What I had to figure out on my own

<session_transcript>
<paste transcript here>
</session_transcript>

Based on this analysis, improve the skill by:
1. Adding missing instructions or clarifications
2. Adding examples for common use cases discovered
3. Fixing any incorrect guidance
4. Making the skill more concise where possible

Write the improved skill back to the same location.

═══════════════════════════════════════════════════════════════════════════════
```

## Workflow: Create a New Skill

When asked to create a new skill from a session:

1. **Extract the session transcript:**
   ```bash
   node "$EXTRACTOR" > /tmp/session-transcript.txt
   ```

2. **Choose the destination with the user.** Supported defaults are project-local `.pi/skills/<skill-name>/SKILL.md` (shared with the project), global `~/.pi/agent/skills/<skill-name>/SKILL.md` (personal), or `skills/<skill-name>/SKILL.md` while authoring a Pi package. Other discovered/settings locations are valid when the project already uses them. Do not default to a Codex directory for a Pi skill.

3. **Generate a creation prompt** for a new session:

```
═══════════════════════════════════════════════════════════════════════════════
COPY THE FOLLOWING PROMPT INTO A NEW AGENT SESSION:
═══════════════════════════════════════════════════════════════════════════════

Analyze this session transcript to extract a reusable skill called "<skill-name>":

<session_transcript>
<paste transcript here>
</session_transcript>

Create a new skill that captures:
1. The core capability or workflow demonstrated
2. Key commands, APIs, or patterns used
3. Common pitfalls and how to avoid them
4. Example usage for typical scenarios

Write the skill to: <agreed-supported-skill-path>/<skill-name>/SKILL.md

Use this format:
---
name: <skill-name>
description: "<one-line description>"
---

# <Skill Name> Skill

<overview and quick reference>

## <Section for each major capability>

<instructions and examples>

═══════════════════════════════════════════════════════════════════════════════
```

## Why a Separate Session?

The improvement prompt is meant to be copied into a **fresh agent session** because:

1. **Token efficiency** - The current session already has a lot of context; starting fresh means only the transcript and skill are loaded
2. **Clean analysis** - The new session can focus purely on improvement without being influenced by the current task
3. **Reproducibility** - The prompt is self-contained and can be shared or reused

## Tips for Good Skill Improvements

When analyzing a transcript, look for:

- **Confusion patterns** - Where did the agent retry or change approach?
- **Missing examples** - What specific commands or code patterns were discovered?
- **Workarounds** - What did the agent have to figure out that wasn't documented?
- **Errors** - What failed and how was it resolved?
- **Successful patterns** - What worked well and should be highlighted?

Keep skills concise - focus on the most important information and examples.
