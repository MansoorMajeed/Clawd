# Clawd

Custom Pi coding agent package — lean system prompt, opinionated workflow. Includes safety guardrails, interactive tooling, and utility skills.

**Important:** When working in this repo, read and edit files relative to the working directory (e.g., `extensions/foo.ts`). Do NOT use `~/.pi/agent/git/github.com/MansoorMajeed/Clawd/` — that's the installed copy, not the source.

## Structure

- `system-prompt.md` — Clawd workflow prompt, prepended to Pi's assembled system prompt
- `extensions/` — 15 active Pi extension entrypoints (TypeScript)
  - `system-prompt.ts` — Loads the tracked workflow prompt without modifying global Pi configuration
  - `permission-guard/` — Default-deny guard for the main session. Scopes file operations to project/read-only/read-write paths, prompts for outside access, and hard-blocks resolved `.git` deletion. Supports `/add-dir`, `/add-dir-read`, `--yolo`, and `.pi/permissions.json` allowlists. It is a safety net, not a security boundary.
  - `read-before-edit.ts` — Requires a successful read or write before native edit; resets after compaction
  - `internet-search.ts` — DuckDuckGo search with separate LLM extraction. Search content remains untrusted; extraction reduces prompt-injection exposure but does not make it trusted.
  - `review.ts` — Code review command supporting PR/branch/commit/folder modes, with optional fix loop and REVIEW_GUIDELINES.md
  - `context/` — `/context` viewer for loaded command extensions and skills, active-context usage, cost, and estimated category breakdowns
  - `session-breakdown.ts` — 7/30/90-day session analytics: tokens, cost, model breakdown, calendar heatmap
  - `footer.ts` — Theme-aware native footer replacement: left-aligned model, context usage, estimated session cost, and preserved extension statuses. Context warnings follow configured compaction headroom; narrow layouts wrap.
  - `session-meter.ts` — Session age indicator without estimated hourly cost
  - `token-tps.ts` — Labeled response throughput and duration-weighted average, including provider waiting/thinking time
  - `chatgpt-limit-status.ts` — ChatGPT quota and reset status
  - `git-status.ts` — Git branch, worktree state, and time-since-commit status
  - `btw.ts` — Side-channel chat popover for focused Q&A. Its side session uses unguarded shell/file tools and does not pass through the main permission guard.
  - `notify.ts` — Native desktop notifications (OSC 777) when the agent settles
  - `split-fork.ts` — Fork session into a new pane (zellij, tmux, Herdr, or Ghostty). Auto-detects multiplexer
- `skills/` — 19 Pi skills (Markdown, one SKILL.md per directory), invoked as `/skill:<name>`
  - **Workflow** (10): research, plan, plan-init, implement-plan, debug, review, ship, save-session, update-docs, address-review. `plan` includes feature/branch setup; `update-docs` includes full-audit mode.
  - **Safety**: irreversible-action-checklist (5-gate verification for destructive actions)
  - **Git**: commit (Conventional Commits-style workflow)
  - **Interactive**: web-browser (Chrome DevTools Protocol automation), tmux (remote control tmux sessions)
  - **Meta**: improve-skill (analyze session transcripts to improve/create skills)
  - **Design**: frontend-design (frontend design and implementation guidelines)
  - **Utility**: librarian (cache remote git repos for reuse), summarize (URL/file to Markdown via markitdown), mermaid (create/validate Mermaid diagrams)
- `experimental/extensions/` — Disabled, unsupported archive of ten known-unfixed extensions: ai-knowledge, journal-advisor, continue, handoff, control, loop, answer, todos, todos-status, and prompt-editor. Nothing here is automatically loaded.
- Native replacements — Use Pi's `/new` instead of the removed `clear` extension and native `edit` instead of the removed `multi-edit` override. Native edit supports multiple disjoint replacements within one file, not cross-file batches or Codex patches.
- `templates/` — Project bootstrapping templates
  - `CLAUDE.md` — Project CLAUDE.md template
  - `Makefile` — Generic Makefile template
  - `makefiles/` — Stack-specific Makefile examples (Python, Java, Node, Go, Rust)

## Installation

```bash
pi install git:github.com/MansoorMajeed/Clawd
```

The tested Pi baseline is **0.85.1**. Wildcard peer dependency ranges do not imply compatibility with every later Pi release.

## How it works

The coding agent (Pi + Opus) handles main reasoning. `system-prompt.ts` prepends the tracked workflow prompt to Pi's assembled system prompt. Other extensions provide safety guardrails, interactive tooling, and structured workflows. Skills provide step-by-step guidance for common development tasks.

This is a base package — environment-specific tools (MCP bridges, admin integrations, custom templates) can be layered on top as separate Pi overlay packages.

## Acknowledgments

Extensions (multi-edit, review, context, session-breakdown, control, btw, loop, notify, prompt-editor) and skills (librarian, summarize, mermaid) from [Armin Ronacher's agent-stuff](https://github.com/mitsuhiko/agent-stuff). This attribution includes source now removed or preserved in the experimental archive. The `split-fork` extension is adapted from mitsuhiko's Ghostty-only version to also support zellij, tmux, and Herdr.
