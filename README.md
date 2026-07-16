# clawd

Custom [Pi](https://github.com/earendil-works/pi) coding agent package. Lean, opinionated, multi-agent.

## Why

Clawd layers an opinionated [workflow prompt](system-prompt.md) over Pi's compact default prompt: discussion before code, plans before execution, no unsolicited "improvements." A small [loader extension](extensions/system-prompt.ts) keeps the prompt in the package, so installs and updates apply it without modifying the user's global `SYSTEM.md`.

Built on [Pi](https://lucumr.pocoo.org/2026/1/31/pi/), an open-source coding agent that's designed to be extended rather than configured. The workflow prompt is the soul of this thing — fork it and make it yours.

## ⚠️ Warning

This is **not** a sandboxed agent. Pi gives the LLM direct bash access with no built-in permission system like Claude Code has. The `permission-guard` extension adds basic guardrails (scoped file access, blocked destructive commands), but it is **not a security boundary** — it's a safety net for honest mistakes, not a jail.

**Run this in a VM, container, or disposable environment** if you're not comfortable with an LLM having shell access to your machine.

## Architecture

```
Pi (main agent, Opus)
├── 10 built-in tools (file, bash, glob, grep, etc.)
├── 21 workflow extensions (safety, editing, review, context, sub-agents)
└── 22 workflow skills (/plan, /ship, /debug, etc.)
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

## Updating

Push changes to this repo, then `pi update --extensions` updates unpinned package installs. To auto-update packages on every launch, add one of these to `~/.zshrc`:

```bash
# Simple: update packages before every launch (adds ~1s latency)
alias pi='pi update --extensions && command pi'

# Background: update packages silently, changes apply next launch
pi() {
  command pi update --extensions &>/dev/null &
  command pi "$@"
}
```

## Skills

| Command | Description |
|---------|-------------|
| `/research` | Research and distill into reference docs |
| `/plan-init` | Initial project plan (architecture, MVP) |
| `/plan` | Plan a change |
| `/new-feature` | Feature branch + scoped plan |
| `/debug` | Root cause first, then fix |
| `/review` | Fresh-context code review |
| `/ship` | Checks, version, changelog, PR |
| `/retro` | Git-based retrospective |
| `/save-session` | Session handoff |
| `/update-docs` | Sync llm-context/ with code |
| `/audit-context` | Full doc audit |
| `/address-review` | Address findings from `.scratch/reviews/` |
| `/commit` | Conventional Commits-style git workflow |
| `/irreversible-action-checklist` | 5-gate verification for destructive actions |
| `/improve-skill` | Analyze session transcripts to improve skills |
| `/web-browser` | Chrome DevTools Protocol automation |
| `/tmux` | Remote control tmux sessions |
| `/frontend-design` | Frontend design guidelines |
| `/perf-optimization-cycle` | Performance optimization workflow |
| `/librarian` | Cache remote git repos for reference reuse |
| `/summarize` | URL/file to Markdown via markitdown |
| `/mermaid` | Create/validate Mermaid diagrams |

## Subagents and review loops

Clawd expects [pi-subagents](https://github.com/nicobailon/pi-subagents) for non-interactive multi-agent workflows. It provides the `subagent` tool, `/review-loop`, `/parallel-review`, async/background runs, fresh-context reviewers, and Ctrl+O expanded output.

Recommended split:

- `/review-loop` — automated worker → fresh reviewers → worker cycles until clean or capped
- `/parallel-review` — fresh reviewer fanout for review-only passes
- `/review` — Clawd's manual fresh-context review flow
- `/address-review` — manual file-based handoff from `.scratch/reviews/`

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

- **[Armin Ronacher's agent-stuff](https://github.com/mitsuhiko/agent-stuff)** — Advanced extensions (multi-edit, review, context, session-breakdown, control, btw, loop, notify, prompt-editor) and utility skills (librarian, summarize, mermaid). The `split-fork` extension is adapted from mitsuhiko's Ghostty-only version to also support zellij, tmux, and Herdr.
