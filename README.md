# clawd

Custom [Pi](https://github.com/badlogic/pi-mono) coding agent package. Lean, opinionated, multi-agent.

## What this is

A Pi package that replaces Claude Code's 35k-token generic system prompt with a ~500-token prompt tuned to a specific workflow. Provides safety guardrails, interactive tooling, and structured workflow skills.

## Architecture

```
Pi (main agent, Opus)
├── 10 built-in tools (file, bash, glob, grep, etc.)
├── 18 workflow extensions (safety, editing, review, context, sub-agents)
└── 22 workflow skills (/plan, /ship, /debug, etc.)
```

## Install

```bash
npm install -g @mariozechner/pi-coding-agent
pi install git:github.com/MansoorMajeed/Clawd
```

## Prerequisites

- [Pi](https://github.com/badlogic/pi-mono) installed (`npm install -g @mariozechner/pi-coding-agent`)

## Updating

Push changes to this repo, then `pi update` pulls them. To auto-update on every launch, add one of these to `~/.zshrc`:

```bash
# Simple: update before every launch (adds ~1s latency)
alias pi='pi update && command pi'

# Background: update silently, changes apply next launch
pi() {
  command pi update &>/dev/null &
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

## Overlay packages

Clawd is designed as a base package. You can layer additional Pi packages on top for environment-specific extensions (e.g., company-specific MCP bridges, admin tools, templates). Pi merges extensions and skills from all installed packages at runtime.

## Acknowledgments

This package incorporates extensions and skills from two excellent agent toolkits:

- **[Rafael Caricio's agent-stuff](https://github.com/rcaricio/agent-stuff)** — Safety guardrails (dangerous-command-guard, irreversible-action-checklist), interactive tooling (answer, todos, handoff, tmux-subagent), and utility skills (commit, improve-skill, web-browser, tmux, internet-search, frontend-design, perf-optimization-cycle).

- **[Armin Ronacher's agent-stuff](https://github.com/mitsuhiko/agent-stuff)** — Advanced extensions (multi-edit, review, context, session-breakdown, control, btw, loop, notify, prompt-editor) and utility skills (librarian, summarize, mermaid). The `split-fork` extension is adapted from mitsuhiko's Ghostty-only version to also support zellij and tmux.
