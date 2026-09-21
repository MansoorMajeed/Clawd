# clawd

Custom [Pi](https://github.com/earendil-works/pi) coding agent package. Lean, opinionated, multi-agent.

## Why

Clawd layers an opinionated [workflow prompt](system-prompt.md) over Pi's compact default prompt: discussion before code, plans before execution, no unsolicited "improvements." A small [loader extension](extensions/system-prompt.ts) keeps the prompt in the package, so installs and updates apply it without modifying the user's global `SYSTEM.md`.

Built on [Pi](https://lucumr.pocoo.org/2026/1/31/pi/), an open-source coding agent that's designed to be extended rather than configured. The workflow prompt is the soul of this thing — fork it and make it yours.

## ⚠️ Warning

This is **not** a sandboxed agent. Pi gives the LLM direct bash access with no built-in permission system like Claude Code has. The `permission-guard` extension adds basic guardrails (scoped file access, silent in-scope recursive deletes, and hard-blocked resolved `.git` deletion), but it is **not a security boundary** — it's a safety net for honest mistakes, not a jail. The active `/btw` side session has unguarded shell and file tools; its tool calls do not pass through the main session's permission guard.

**Run this in a VM, container, or disposable environment** if you're not comfortable with an LLM having shell access to your machine.

## Architecture

```
Pi (main agent, Opus)
├── Pi's native tools and commands
├── 16 active extension entrypoints (safety, review, context, displays, utilities)
└── 19 active skills (/skill:plan, /skill:ship, /skill:debug, etc.)
```

## Install

```bash
npm install -g @earendil-works/pi-coding-agent
pi install git:github.com/MansoorMajeed/Clawd
pi install npm:pi-subagents
```

## Prerequisites

- [Pi](https://github.com/earendil-works/pi) installed (`npm install -g @earendil-works/pi-coding-agent`)
- [pi-subagents](https://github.com/nicobailon/pi-subagents) installed (`pi install npm:pi-subagents`) for non-interactive subagents, review loops, and parallel review workflows

Clawd is tested against Pi **0.85.1**. Its wildcard peer dependencies allow Pi to provide the runtime packages; they are not a claim of compatibility with every Pi version.

## Updating

Push changes to this repo, then `pi update --extensions` updates unpinned package installs. To update packages before every launch, add this to `~/.zshrc`:

```bash
alias pi='pi update --extensions && command pi'
```

## Footer

Clawd replaces Pi's native footer with a small, theme-aware layout:

```text
~/git/Clawd (main)
gpt-6-astra · medium · Context 55k / 272k (20%) · Est. $2.25
GPT W 78% ↓6d · git ✓ · 24m · Speed 42.0 tok/s · avg 38.0 tok/s
```

The model is highlighted; path, thinking level, and cost are muted. Context shows the active model's configured window, not cumulative token traffic. It turns yellow/red at 80%/95% of the native compaction trigger (`window - reserveTokens`). With auto-compaction disabled, it shows `auto off` and warns relative to the full window. Settings are refreshed on session start, model changes, and before each turn. Unknown usage after compaction displays `?`, not zero.

`Est.` is the accumulated session cost from recorded usage, including tool and summarization usage where available—not a subscription charge. Speed measures provider-reported output tokens over the whole response duration, including waiting/thinking but excluding idle and tool execution; its average covers responses measured since this extension loaded. Session age remains visible without the estimated hourly burn rate.

Existing extension statuses (including GPT quota, reset time, and git status) retain their colors. On narrow terminals, the path shortens and metrics/statuses wrap. This changes display only; model limits and native compaction behavior are unchanged.

## Active extensions

The 16 active entrypoints provide the workflow prompt; permission and read-before-edit guards; DuckDuckGo search; interactive review; context and session analytics; a `/clear` reminder for Pi's native `/new`; `/btw`; `/split-fork`; desktop notifications; and the custom footer/status displays for GPT quota, git state, session age, and response throughput. Extension commands are `/add-dir`, `/add-dir-read`, `/review`, `/end-review`, `/context`, `/session-breakdown`, `/clear`, `/btw`, and `/split-fork`.

`/clear` only reminds users to use Pi's native `/new` command; it does not alias `/new` or change the current session. The old session-reset behavior and `multi-edit` override remain removed. Use Pi's native `edit` tool instead; it accepts multiple disjoint replacements in one file but does not provide cross-file batches or Codex-style patch application.

## Skills

| Skill command | Description |
|---------|-------------|
| `/skill:research` | Research and distill into reference docs |
| `/skill:plan-init` | Initial project plan (architecture, MVP) |
| `/skill:plan` | Plan a feature or change, including branch scope |
| `/skill:implement-plan` | Execute an approved plan phase by phase |
| `/skill:debug` | Root cause first, then fix |
| `/skill:review` | Portable fresh-context, file-based code review (distinct from `/review`) |
| `/skill:address-review` | Address findings from `.scratch/reviews/` |
| `/skill:ship` | Checks, version, changelog, push, and PR |
| `/skill:save-session` | Save handoff state under `.scratch/sessions/` |
| `/skill:update-docs` | Incremental documentation updates or a full documentation audit |
| `/skill:commit` | Conventional Commits-style git workflow |
| `/skill:irreversible-action-checklist` | Verification for destructive actions |
| `/skill:improve-skill` | Analyze session transcripts to improve skills |
| `/skill:web-browser` | Chrome DevTools Protocol automation |
| `/skill:tmux` | Remote control tmux sessions |
| `/skill:frontend-design` | Frontend design and implementation guidance |
| `/skill:librarian` | Cache remote git repos for reference reuse |
| `/skill:summarize` | URL/file to Markdown via markitdown |
| `/skill:mermaid` | Create and validate Mermaid diagrams |

Feature/branch planning formerly documented as `new-feature` is now part of `plan`. Full documentation auditing formerly documented as `audit-context` is now a mode of `update-docs`.

## Experimental archive

Ten former extensions are preserved under [`experimental/extensions/`](experimental/extensions/): `ai-knowledge`, `journal-advisor`, `continue`, `handoff`, `control`, `loop`, `answer`, `todos`, `todos-status`, and `prompt-editor`. They are disabled, not automatically loaded, unsupported, and known to have unfixed compatibility, state, or lifecycle problems. Their dedicated tests are retained under `experimental/tests/` but are excluded from the active test suite.

## Subagents and review loops

Clawd expects [pi-subagents](https://github.com/nicobailon/pi-subagents) for non-interactive multi-agent workflows. It provides the `subagent` tool, `/review-loop`, `/parallel-review`, async/background runs, fresh-context reviewers, and Ctrl+O expanded output.

Recommended split:

- `/review-loop` — automated worker → fresh reviewers → worker cycles until clean or capped
- `/parallel-review` — fresh reviewer fanout for review-only passes
- `/review` — Clawd's interactive review extension
- `/skill:review` — portable fresh-context review that writes a findings file
- `/skill:address-review` — manual file-based handoff from `.scratch/reviews/`

## MCP support

Pi doesn't have built-in MCP support, but you can add it with [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter):

```bash
pi install npm:pi-mcp-adapter
```

This reads your existing `claude_desktop_config.json` or `mcp.json` and exposes MCP servers as Pi tools. See the [adapter repo](https://github.com/nicobailon/pi-mcp-adapter) for configuration details.

## Overlay packages

Clawd is designed as a base package. You can layer additional Pi packages on top for environment-specific extensions (e.g., company-specific MCP bridges, admin tools, templates). Pi merges extensions and skills from all installed packages at runtime.

## Acknowledgments

This package incorporates extensions and skills from:

- **[Armin Ronacher's agent-stuff](https://github.com/mitsuhiko/agent-stuff)** — Advanced extensions (multi-edit, review, context, session-breakdown, control, btw, loop, notify, prompt-editor) and utility skills (librarian, summarize, mermaid). This attribution includes source now removed or preserved in the experimental archive. The `split-fork` extension is adapted from mitsuhiko's Ghostty-only version to also support zellij, tmux, and Herdr.
