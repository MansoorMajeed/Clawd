# Clawd

Custom Pi coding agent package — lean system prompt, opinionated workflow. Includes safety guardrails, interactive tooling, and utility skills.

## Structure

- `extensions/` — Pi extensions (TypeScript)
  - `workflow-guard.ts` — Injects custom system prompt, enforces "no code before plan" rule
  - `permission-guard/` — Default-deny permission system. Scopes file operations to project directory, blocks destructive commands, prompts for outside access. Supports `/add-dir`, `--yolo` bypass, and `.pi/permissions.json` allowlists
  - `handoff.ts` — Generates a context-transfer prompt from the current conversation for a new focused session
  - `internet-search.ts` — Internet search via DuckDuckGo with isolated LLM extraction to prevent prompt injection
  - `answer.ts` — Extracts questions from last assistant message into interactive Q&A interface (`/answer` or `Ctrl+.`)
  - `todos.ts` — File-based todo manager in `.pi/todos/`. LLM tool for CRUD + claim/release, visual `/todos` browser with fuzzy search
  - `tmux-subagent/` — Spawns sub-agents as visible interactive Pi sessions in tmux windows. Supports fan-out, steering, peer messaging, live dashboard
  - `multi-edit.ts` — Replaces built-in `edit` tool with batch edits and Codex-style patch support, with preflight validation
  - `review.ts` — Code review command supporting PR/branch/commit/folder modes, with optional fix loop and REVIEW_GUIDELINES.md
  - `context.ts` — TUI context viewer: loaded extensions, skills, token usage, cost, context window utilization
  - `session-breakdown.ts` — 7/30/90-day session analytics: tokens, cost, model breakdown, calendar heatmap
  - `control.ts` — Inter-session communication via Unix domain sockets (JSON-RPC protocol)
  - `btw.ts` — Side-channel chat popover for focused Q&A without disrupting main conversation
  - `loop.ts` — `/loop` with breakout conditions: test-driven, custom conditions, or self-directed
  - `notify.ts` — Native desktop notifications (OSC 777) when the agent finishes
  - `split-fork.ts` — Fork session into a new pane (zellij, tmux, or Ghostty). Auto-detects multiplexer
  - `prompt-editor.ts` — In-editor prompt selector with persistence, history, thinking level toggle
  - `clear.ts` — `/clear` command to reset conversation to blank slate (preserves session file)
  - `read-before-edit.ts` — Blocks edit calls on files not read/written in current session. Resets after compaction.
  - `compact-advisor.ts` — Suggests compaction at 150k tokens with task-aware instructions. 5-minute cooldown.
- `skills/` — Pi skills (Markdown, one SKILL.md per directory)
  - **Workflow** (11): research (distill into `.scratch/`, gitignored), plan (write to `.scratch/`, n2c annotation loop), plan-init, new-feature, debug, review, ship, retro, save-session, update-docs, audit-context
  - **Safety**: irreversible-action-checklist (5-gate verification for destructive actions)
  - **Git**: commit (Conventional Commits-style workflow)
  - **Interactive**: web-browser (Chrome DevTools Protocol automation), tmux (remote control tmux sessions)
  - **Meta**: improve-skill (analyze session transcripts to improve/create skills)
  - **Design**: frontend-design (frontend design guidelines), perf-optimization-cycle
  - **Utility**: librarian (cache remote git repos for reuse), summarize (URL/file to Markdown via markitdown), mermaid (create/validate Mermaid diagrams)
- `templates/` — Project bootstrapping templates
  - `CLAUDE.md` — Project CLAUDE.md template
  - `Makefile` — Generic Makefile template
  - `makefiles/` — Stack-specific Makefile examples (Python, Java, Node, Go, Rust)

## Installation

```bash
pi install git:github.com/MansoorMajeed/Clawd
```

## How it works

The coding agent (Pi + Opus) handles main reasoning with a lean system prompt (~1100 tokens). Extensions provide safety guardrails, interactive tooling, and structured workflows. Skills provide step-by-step guidance for common development tasks.

This is a base package — environment-specific tools (MCP bridges, admin integrations, custom templates) can be layered on top as separate Pi overlay packages.

## Acknowledgments

Safety guardrails (dangerous-command-guard, irreversible-action-checklist), interactive tooling (web-browser, tmux, answer, todos, handoff, tmux-subagent), and utility skills (commit, improve-skill, frontend-design, perf-optimization-cycle, internet-search) adapted from [Rafael Caricio's agent-stuff](https://github.com/rcaricio/agent-stuff).

Extensions (multi-edit, review, context, session-breakdown, control, btw, loop, notify, prompt-editor) and skills (librarian, summarize, mermaid) from [Armin Ronacher's agent-stuff](https://github.com/mitsuhiko/agent-stuff). The `split-fork` extension is adapted from mitsuhiko's Ghostty-only version to also support zellij and tmux.
