# tmux-subagent

A [Pi](https://github.com/badlogic/pi) extension that spawns sub-agents as **visible, interactive pi sessions** in tmux windows. The user can switch to any sub-agent's tmux tab, watch it work, and interact with it directly — while the parent LLM orchestrates the overall workflow.

## Requirements

- **tmux** — pi must be running inside a tmux session
- **Agent definitions** — `.md` files in `~/.pi/agent/agents/` (user-level) or `.pi/agents/` (project-level)

## Quick Start

```bash
# Start pi inside tmux with the extension loaded
tmux new-session -s work
pi -e ./extensions/tmux-subagent
```

Then ask the LLM to spawn agents:

```
Spawn a scout agent to find all TODO comments in the codebase
```

## Agent Definitions

Create markdown files with YAML frontmatter in `~/.pi/agent/agents/`:

```markdown
---
name: scout
description: Fast codebase reconnaissance
tools: read,grep,find,ls,bash
model: claude-haiku-4-5
output: context.md
---

You are a fast reconnaissance agent. Explore the codebase
and return structured findings.
```

**Frontmatter fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Agent identifier used in spawn commands |
| `description` | yes | What this agent does |
| `tools` | no | Comma-separated list of pi tools to enable |
| `model` | no | LLM model override (e.g., `claude-haiku-4-5`) |
| `output` | no | Result filename (default: `result.md`) |

The markdown body becomes the agent's system prompt.

If no agent name is specified when spawning, the extension defaults to `worker` (or the first available agent).

## Supervisor Tool — `tmux_subagent`

The supervisor's tool for orchestrating sub-agents:

### `spawn` — Create a sub-agent

```
tmux_subagent({ action: "spawn", agent: "scout", task: "Find all .ts files" })
```

**Fan-out** — spawn multiple agents at once:

```
tmux_subagent({
  action: "spawn",
  tasks: [
    { agent: "scout", task: "Find all .ts files" },
    { agent: "worker", task: "Count lines in package.json" }
  ]
})
```

### `wait` — Block until agents finish

```
tmux_subagent({ action: "wait" })              // wait for all running agents
tmux_subagent({ action: "wait", timeout: 30 }) // wait up to 30 seconds
tmux_subagent({ action: "wait", id: "abc1" })  // wait for a specific agent
```

Returns early when agents finish or when a sub-agent asks a question. Default timeout: 120s.

### `steer` — Send instructions to a running agent

```
tmux_subagent({ action: "steer", id: "abc1", message: "Focus on error handling", deliverAs: "steer" })
```

- `deliverAs: "steer"` (default) — **Interrupts** current work
- `deliverAs: "followUp"` — **Waits** for agent to finish current turn

### `check` / `collect` / `kill` / `list`

```
tmux_subagent({ action: "check", id: "abc1" })    // poll status + output preview
tmux_subagent({ action: "collect", id: "abc1" })   // get result file contents
tmux_subagent({ action: "kill", id: "abc1" })      // terminate agent
tmux_subagent({ action: "list" })                   // show all tracked agents
```

## Sub-Agent Tool — `team`

Every sub-agent gets a `team` tool for communicating with the supervisor and peers:

### Status updates

```
team({ status: "scanning tests..." })
```

Updates the agent's line in the supervisor's dashboard widget. Lightweight, no conversation message.

### Ask the supervisor

```
team({ ask: "Should I fix this bug or just document it?" })
```

Sends a question to the supervisor (rendered with `📋` prefix). The supervisor responds via `steer`. Wakes up any active `wait` in the supervisor.

### Peer messaging

```
team({ to: "scout-a3b1", message: "Did you find the config files?" })
```

Sends a message to another agent. Routed through the supervisor's server. Both the target agent and the supervisor see the message (`💬` prefix in supervisor history).

### Discover teammates

```
team({})
```

Returns a list of all agents with their id, name, task, status, and current status text. Reads from a roster file maintained by the supervisor.

### Wait for messages

```
team({ timeout: 30 })
```

Blocks up to N seconds until an incoming message (steer or peer) arrives. **Use this instead of `bash sleep`** — it wakes immediately when a message arrives.

Can be combined: `team({ ask: "Need guidance", timeout: 60 })` sends the question then waits for the response.

## Architecture

### Communication Flow

```
┌─────────────┐   steer (socket)    ┌─────────────┐   steer (socket)    ┌─────────────┐
│  Supervisor  │ ──────────────────→ │  TeamServer  │ ──────────────────→ │  Sub-agent   │
│              │                     │  (hub)       │                     │              │
│  tmux_subagent                     │              │ ←────────────────── │  team tool   │
│  tool        │ ←────────────────── │              │   status/ask/peer   │              │
│              │   ask (wakes wait)  │              │                     │              │
│              │   peer (displayed)  │              │ ──────────────────→ │  Sub-agent   │
│              │                     │              │   peer (routed)     │              │
└─────────────┘                     └─────────────┘                     └─────────────┘
```

### Wire Protocol

Newline-delimited JSON over Unix domain socket (`/tmp/pi-team-{id}.sock`):

| Message | Direction | Purpose |
|---------|-----------|---------|
| `{ type: "identify", id }` | client → server | Register agent on connect |
| `{ type: "steer", message, deliverAs }` | server → client | Supervisor instruction |
| `{ type: "report", id, status?, ask? }` | client → server | Status update or question |
| `{ type: "peer", from, to, message }` | client → server → client | Agent-to-agent message |

### Team Roster

The supervisor writes a roster file (`/tmp/pi-team-{id}-roster.json`) on each poll cycle. Sub-agents read it for teammate discovery and peer message target resolution.

### Dashboard Widget

The supervisor's TUI shows a live dashboard:

```
Tmux sub-agents
 ⏳ [alpha] worker-07a2  running  12s  › scanning tests...
 ✓  [beta]  worker-1ce9  done     8s  (result ready)
```

Status text (after `›`) is set by sub-agents via `team({ status: "..." })`.

## Files

| File | Description |
|------|-------------|
| `index.ts` | Main extension — supervisor tool, team tool, widget, poller, message renderers |
| `pubsub.ts` | Wire protocol — TeamServer (hub) and TeamClient over Unix domain sockets |
| `agents.ts` | Agent discovery — loads `.md` definitions from user and project directories |
| `tmux.ts` | tmux CLI helpers — create/kill windows, capture pane output |
| `types.ts` | Shared TypeScript types and constants |
| `package.json` | Pi extension package manifest |
