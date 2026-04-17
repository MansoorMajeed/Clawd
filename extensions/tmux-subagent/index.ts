/**
 * tmux-subagent extension
 *
 * Spawns sub-agents as visible interactive pi sessions in tmux windows.
 * The user can switch to any agent's window, monitor it, and interact directly.
 * The parent LLM orchestrates via spawn/check/collect/kill/list actions.
 */

import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { discoverAgents } from "./agents.js";
import * as tmux from "./tmux.js";
import { TeamServer, TeamClient, type DeliverAs } from "./pubsub.js";
import {
  type AgentScope,
  type TrackedAgent,
  type ToolDetails,
  RUN_DIR_BASE,
  MAX_AGENTS,
  POLL_INTERVAL_MS,
  WIDGET_KEY,
  PANE_CAPTURE_LINES,
  RESULT_PREVIEW_LINES,
  MAX_RESULT_BYTES,
  MAX_RESULT_LINES,
} from "./types.js";

// ─── Helpers ──────────────────────────────────────────────

function shortId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m${secs.toString().padStart(2, "0")}s`;
}

function truncateResult(text: string): string {
  const lines = text.split("\n");
  const bytes = Buffer.byteLength(text, "utf-8");

  if (bytes <= MAX_RESULT_BYTES && lines.length <= MAX_RESULT_LINES) {
    return text;
  }

  let truncated = lines.slice(0, MAX_RESULT_LINES).join("\n");
  if (Buffer.byteLength(truncated, "utf-8") > MAX_RESULT_BYTES) {
    let lo = 0;
    let hi = truncated.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (Buffer.byteLength(truncated.slice(0, mid), "utf-8") <= MAX_RESULT_BYTES) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    truncated = truncated.slice(0, lo);
  }

  const keptLines = truncated.split("\n").length;
  return `[TRUNCATED: ${keptLines} of ${lines.length} lines shown]\n${truncated}`;
}

function buildSystemPrompt(
  agentConfig: { systemPrompt: string; output?: string },
  resultFile: string,
  runDir: string,
): string {
  const sharedDir = path.join(path.dirname(runDir), "shared");
  const outputProtocol = `
## Sub-agent Protocol

You are running as a sub-agent in a tmux-based orchestration system.
You are in a full interactive pi session — a human may switch to your
terminal at any time to watch your progress or interact with you directly.

**CRITICAL — Your output file:** \`${resultFile}\`
When you finish your task, you MUST write your results to this file using
the write tool. This is the ONLY way the orchestrator knows you are done.
The orchestrator polls for this file — until it exists and is non-empty,
you are considered "still running".

**Shared workspace:** \`${sharedDir}/\`
You may read files placed here by other agents for context.
You may write files here for other agents to consume.

**If a human interacts with you directly**, follow their instructions —
they take priority over the original task.

**Supervisor steering:** You may receive steering messages from the
supervisor during your work. These are high-priority instructions —
adjust your approach accordingly.

**Team communication:** Use the \`team\` tool to:
- \`status\`: Update your line in the supervisor's dashboard (lightweight)
- \`ask\`: Ask the supervisor a question (response arrives via steering)
- \`to\` + \`message\`: Send a message to a teammate by id or name
- \`timeout\`: Wait up to N seconds for an incoming message (steer or peer)
Use \`team\` with no params to see all teammates and their current tasks.
**NEVER use bash sleep** — use \`team({ timeout: N })\` to wait for messages.
`;

  const base = agentConfig.systemPrompt?.trim() || "";
  return base ? `${base}\n\n${outputProtocol}` : outputProtocol;
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9._\-/=:@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─── Extension ────────────────────────────────────────────

export default function tmuxSubagentExtension(pi: ExtensionAPI) {
  pi.registerFlag("agentic-team-socket", { type: "string", description: "Team socket path" });
  pi.registerFlag("agentic-team-id", { type: "string", description: "Agent id in team" });

  const tracked = new Map<string, TrackedAgent>();
  let tmuxSession: string | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  let lastCtx: ExtensionContext | null = null;
  let teamServer: TeamServer | null = null;
  let teamClient: TeamClient | null = null;

  let teamSocketPath: string | null = null;
  const pendingAsks: { label: string; question: string }[] = [];
  const pendingPeerMessages: { from: string; to: string; message: string }[] = [];
  let wakeWaiters: (() => void) | null = null;
  let messageWakeup: (() => void) | null = null;
  let hasUnreadMessage = false;
  const incomingMessages: string[] = [];

  function buildRoster() {
    return Array.from(tracked.values()).map((a) => ({
      id: a.id,
      agent: a.agent,
      task: a.task,
      status: a.status,
      statusText: a.statusText,
      windowName: a.windowName,
    }));
  }

  function broadcastRoster(): void {
    teamServer?.broadcastRoster(buildRoster());
  }

  function resolveRosterTarget(roster: any[], target: string): any | undefined {
    return roster.find((a: any) =>
      a.id === target ||
      a.id.startsWith(target) ||
      a.windowName === target ||
      `${a.agent}-${a.id.slice(0, 4)}` === target,
    );
  }

  function agentLabel(agentId: string): string {
    const a = tracked.get(agentId);
    return a ? `${a.agent}-${agentId.slice(0, 4)}` : agentId.slice(0, 8);
  }

  // ── Poller: update agent statuses + widget ──

  function setFinished(agent: TrackedAgent, status: "done" | "failed" | "lost"): void {
    agent.status = status;
    if (!agent.endTime) agent.endTime = Date.now();
  }

  function refreshStatuses(): void {
    if (!tmuxSession) return;

    for (const agent of tracked.values()) {
      if (agent.status === "done" || agent.status === "failed") continue;

      // Primary completion signal: result file exists and is non-empty.
      if (fs.existsSync(agent.resultFile)) {
        try {
          if (fs.statSync(agent.resultFile).size > 0) {
            setFinished(agent, "done");
            continue;
          }
        } catch { /* ignore */ }
      }

      const info = tmux.getWindowInfo(tmuxSession, agent.windowName);

      if (!info) {
        setFinished(agent, "lost");
        continue;
      }

      if (info.paneDead) {
        setFinished(agent, "failed");
        continue;
      }

      agent.status = "running";
    }
  }

  function updateWidget(): void {
    if (!lastCtx?.hasUI) return;

    const agents = Array.from(tracked.values());
    if (agents.length === 0) {
      lastCtx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const theme = lastCtx.ui.theme;
    const lines: string[] = [];
    lines.push(theme.fg("accent", theme.bold("Tmux sub-agents")));

    for (const a of agents) {
      const elapsed = formatDuration((a.endTime ?? Date.now()) - a.startTime);
      const icon =
        a.status === "done"
          ? theme.fg("success", "✓")
          : a.status === "failed"
            ? theme.fg("error", "✗")
            : a.status === "lost"
              ? theme.fg("error", "?")
              : theme.fg("warning", "⏳");
      const hint =
        a.status === "done" ? theme.fg("dim", " (result ready)") : "";
      const statusHint = a.statusText && a.status === "running"
        ? theme.fg("dim", ` › ${a.statusText}`)
        : "";
      const winIdx = theme.fg("muted", `[${a.windowName}]`);
      lines.push(
        ` ${icon} ${winIdx} ${theme.fg("text", a.agent)}-${theme.fg("dim", a.id.slice(0, 4))}  ${theme.fg("muted", a.status)}  ${theme.fg("dim", elapsed)}${hint}${statusHint}`,
      );
    }

    lastCtx.ui.setWidget(WIDGET_KEY, lines);
  }

  function ensurePoller(): void {
    if (poller) return;
    poller = setInterval(() => {
      refreshStatuses();
      updateWidget();
      broadcastRoster();
      const anyRunning = Array.from(tracked.values()).some(
        (a) => a.status === "running",
      );
      if (!anyRunning && poller) {
        clearInterval(poller);
        poller = null;
      }
    }, POLL_INTERVAL_MS);
    poller.unref?.();
  }

  function ensureTeamServer(): string {
    if (teamServer) return teamServer.socketPath;
    teamSocketPath = path.join("/tmp", `pi-team-${shortId()}.sock`);
    teamServer = new TeamServer(
      teamSocketPath,
      (agentId, report) => {
        const label = agentLabel(agentId);
        const agent = tracked.get(agentId);

        if (report.status && agent) {
          agent.statusText = report.status;
          updateWidget();
          broadcastRoster();
        }

        if (report.ask) {
          pendingAsks.push({ label, question: report.ask });
          pi.sendMessage(
            { customType: "agent-ask", content: `${label} asks: ${report.ask}`, display: true },
            { triggerTurn: true, deliverAs: "followUp" },
          );
          wakeWaiters?.();
        }
      },
      (from, to, message) => {
        const fromLabel = agentLabel(from);
        const toLabel = agentLabel(to);
        pendingPeerMessages.push({ from: fromLabel, to: toLabel, message });
        pi.sendMessage(
          { customType: "peer-message", content: `${fromLabel} → ${toLabel}: ${message}`, display: true },
          { triggerTurn: false },
        );
        wakeWaiters?.();
      },
    );
    return teamSocketPath;
  }

  // ── Tool schema ──

  const ToolParams = Type.Object({
    action: StringEnum([
      "spawn",
      "check",
      "collect",
      "kill",
      "list",
      "wait",
      "steer",
    ] as const),
    agent: Type.Optional(
      Type.String({
        description:
          'Agent definition name (from ~/.pi/agent/agents/ or .pi/agents/). Defaults to "worker" if omitted, or the first available agent.',
      }),
    ),
    task: Type.Optional(
      Type.String({
        description: "Task to delegate. Use {run_dir} as placeholder for the shared run directory path.",
      }),
    ),
    name: Type.Optional(
      Type.String({ description: "tmux window name (default: agent-shortId)" }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "Working directory for the sub-agent" }),
    ),
    id: Type.Optional(
      Type.String({ description: "Sub-agent id (for check/collect/kill)" }),
    ),
    tasks: Type.Optional(
      Type.Array(
        Type.Object({
          agent: Type.Optional(Type.String()),
          task: Type.String(),
          name: Type.Optional(Type.String()),
        }),
        { description: "Spawn multiple sub-agents at once (fan-out). Agent defaults to 'worker' if omitted." },
      ),
    ),
    timeout: Type.Optional(
      Type.Number({
        description: "Timeout in seconds for the wait action. Default: 120. Returns early when all agents finish.",
      }),
    ),
    message: Type.Optional(
      Type.String({ description: "Steering message to send to a running agent" }),
    ),
    deliverAs: Type.Optional(
      StringEnum(["steer", "followUp"] as const, {
        description: '"steer" interrupts current work, "followUp" waits for it to finish. Default: "steer".',
      }),
    ),
    agentScope: Type.Optional(
      StringEnum(["user", "project", "both"] as const, {
        description: 'Agent discovery scope. Default: "user".',
      }),
    ),
  });

  // ── Tool registration ──

  pi.registerTool({
    name: "tmux_subagent",
    label: "Tmux Subagent",
    description:
      "Spawn and manage sub-agents as visible pi sessions in tmux windows. " +
      "Each sub-agent runs as a full interactive pi session in its own tmux tab — the user can switch to it and interact directly. " +
      "Actions: spawn (create agent), wait (block until agents finish or timeout — use this instead of sleep!), check (poll status), collect (get result), kill (terminate), list (show all), steer (send instructions to a running agent with deliverAs: \"steer\" to interrupt or \"followUp\" to wait). " +
      "Use {run_dir} in task text as a placeholder for the shared run directory path. " +
      "IMPORTANT: After collecting results, the agent's tmux window stays open. Do NOT kill it automatically — ask the user first whether they want to close it, because they may want to interact with the sub-agent further.",
    parameters: ToolParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const scope: AgentScope = params.agentScope ?? "user";
      const agents = discoverAgents(ctx.cwd, scope).agents;
      const action = params.action;

      if (action === "spawn") return handleSpawn(params, agents, ctx);
      if (action === "wait") return handleWait(params, _signal);
      if (action === "steer") return handleSteer(params);
      if (action === "check") return handleCheck(params);
      if (action === "collect") return handleCollect(params);
      if (action === "kill") return handleKill(params);
      if (action === "list") return handleList();

      return {
        content: [{ type: "text", text: `Unknown action: ${action}` }],
        isError: true,
        details: { action } as ToolDetails,
      };
    },

    renderCall(args, theme) {
      const action = args.action || "?";
      let label = theme.fg("toolTitle", theme.bold("tmux_subagent "));

      if (action === "spawn" && args.tasks?.length) {
        label += theme.fg("accent", `spawn ×${args.tasks.length}`);
      } else if (action === "spawn") {
        label += theme.fg("accent", `spawn ${args.agent || "?"}`);
      } else if (action === "wait") {
        const t = args.timeout ? ` ${args.timeout}s` : "";
        label += theme.fg("accent", `wait${args.id ? " " + args.id : ""}${t}`);
      } else if (action === "check" || action === "collect" || action === "kill") {
        label += theme.fg("accent", `${action} ${args.id || "?"}`);
      } else if (action === "steer") {
        const mode = args.deliverAs === "followUp" ? "follow-up" : "interrupt";
        label += theme.fg("accent", `steer ${args.id || "?"} (${mode})`);
      } else {
        label += theme.fg("accent", action);
      }
      return new Text(label, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as ToolDetails | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
      }

      if (d.error) {
        return new Text(theme.fg("error", d.error), 0, 0);
      }

      if (d.action === "list" && d.agents) {
        if (d.agents.length === 0) {
          return new Text(theme.fg("dim", "No active sub-agents"), 0, 0);
        }
        const lines = d.agents.map((a) => {
          const elapsed = formatDuration((a.endTime ?? Date.now()) - a.startTime);
          const icon =
            a.status === "done" ? "✓" : a.status === "failed" ? "✗" : "⏳";
          return `${icon} [${a.windowName}] ${a.agent}-${a.id.slice(0, 4)}  ${a.status}  ${elapsed}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      }

      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "(ok)", 0, 0);
    },
  });

  pi.registerMessageRenderer("supervisor-steer", (message, _options, theme) => {
    return new Text(`${theme.fg("warning", "⚡ SUPERVISOR")} ${message.content}`, 0, 0);
  });

  pi.registerMessageRenderer("agent-ask", (message, _options, theme) => {
    return new Text(`${theme.fg("accent", "📋")} ${message.content}`, 0, 0);
  });

  pi.registerMessageRenderer("peer-message", (message, _options, theme) => {
    return new Text(`${theme.fg("dim", "💬")} ${message.content}`, 0, 0);
  });

  // ── Team tool (functional in sub-agents, registered always) ──

  pi.registerTool({
    name: "team",
    label: "Team",
    description:
      "Communicate with the supervisor. " +
      "Use 'status' to update your line in the supervisor's agent dashboard. " +
      "Use 'ask' to send a question — the supervisor will respond via a steering message. " +
      "Only works when running as a sub-agent.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: "Status text shown in supervisor's agent dashboard" }),
      ),
      ask: Type.Optional(
        Type.String({ description: "Question for the supervisor — they'll respond via steering" }),
      ),
      to: Type.Optional(
        Type.String({ description: "Send a message to a teammate by id, name, or window name" }),
      ),
      message: Type.Optional(
        Type.String({ description: "Message content (used with 'to')" }),
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Wait up to N seconds for an incoming message (steer or peer). Use instead of bash sleep." }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!teamClient) {
        return {
          content: [{ type: "text" as const, text: "Not connected to supervisor" }],
          isError: true,
          details: { error: "Not connected" } as ToolDetails,
        };
      }

      const hasAction = params.status || params.ask || params.to;
      if (!hasAction && !params.timeout) {
        const roster = teamClient.getRoster();
        if (roster.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No teammates found" }],
            details: { action: "team" } as ToolDetails,
          };
        }
        const lines = roster.map((a: any) => {
          const status = a.statusText ? ` › ${a.statusText}` : "";
          return `${a.agent}-${a.id.slice(0, 4)} [${a.windowName}]  ${a.status}  task: ${a.task}${status}`;
        });
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { action: "team" } as ToolDetails,
        };
      }

      const parts: string[] = [];

      if (params.status) {
        teamClient.setStatus(params.status);
        parts.push("Status updated");
      }

      if (params.ask) {
        teamClient.ask(params.ask);
        parts.push("Question sent to supervisor");
      }

      if (params.to) {
        if (!params.message) {
          return {
            content: [{ type: "text" as const, text: "'message' is required with 'to'" }],
            isError: true,
            details: { error: "Missing message" } as ToolDetails,
          };
        }
        const roster = teamClient.getRoster();
        const target = resolveRosterTarget(roster, params.to);
        if (!target) {
          return {
            content: [{ type: "text" as const, text: `No teammate found matching "${params.to}"` }],
            isError: true,
            details: { error: "Teammate not found" } as ToolDetails,
          };
        }
        teamClient.sendPeer(target.id, params.message);
        parts.push(`Message sent to ${target.agent}-${target.id.slice(0, 4)}`);
      }

      if (params.timeout) {
        let received = hasUnreadMessage;
        hasUnreadMessage = false;
        if (!received) {
          received = await new Promise<boolean>((resolve) => {
            messageWakeup = () => { hasUnreadMessage = false; resolve(true); };
            setTimeout(() => { messageWakeup = null; resolve(false); }, params.timeout! * 1000);
          });
        }
        if (received && incomingMessages.length > 0) {
          const msgs = incomingMessages.splice(0);
          parts.push(`Messages received:\n${msgs.join("\n")}`);
        } else {
          parts.push(received ? "Message received" : `No messages within ${params.timeout}s`);
        }
      }

      return {
        content: [{ type: "text" as const, text: parts.join(". ") }],
        details: { action: "team" } as ToolDetails,
      };
    },

    renderCall(args, theme) {
      let label = theme.fg("toolTitle", theme.bold("team "));
      if (args.to) label += theme.fg("accent", `→ ${args.to}`);
      else if (args.ask) label += theme.fg("accent", "ask");
      else if (args.status) label += theme.fg("accent", "status");
      else label += theme.fg("accent", "list");
      return new Text(label, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as ToolDetails | undefined;
      if (d?.error) return new Text(theme.fg("error", d.error), 0, 0);
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "(ok)", 0, 0);
    },
  });

  // ── Action handlers ──

  function handleSpawn(
    params: any,
    agents: any[],
    ctx: ExtensionContext,
  ) {
    // Verify tmux
    if (!tmux.isInsideTmux()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "tmux-subagent requires running inside tmux. Start pi inside tmux:\n  tmux new-session -s pi 'pi'",
          },
        ],
        isError: true,
        details: { action: "spawn", error: "Not inside tmux" } as ToolDetails,
      };
    }

    if (!tmuxSession) {
      tmuxSession = tmux.getTmuxSession();
    }

    // Multi-spawn
    if (params.tasks && params.tasks.length > 0) {
      const results: any[] = [];
      const batchRunId = shortId();
      const batchRunDir = path.join(RUN_DIR_BASE, batchRunId);
      fs.mkdirSync(path.join(batchRunDir, "shared"), { recursive: true });

      for (const t of params.tasks) {
        if (tracked.size >= MAX_AGENTS) {
          results.push({ error: `Max ${MAX_AGENTS} agents reached` });
          continue;
        }
        const r = spawnOne(
          t.agent,
          t.task,
          t.name,
          params.cwd ?? ctx.cwd,
          agents,
          batchRunDir,
        );
        results.push(r);
      }

      ensurePoller();
      updateWidget();
      broadcastRoster();

      const spawned = results.filter((r) => !r.error);
      const failed = results.filter((r) => r.error);
      let text = `Spawned ${spawned.length} sub-agent(s) in tmux windows.`;
      for (const s of spawned) {
        text += `\n  ${s.windowName} — id: ${s.id}, result: ${s.resultFile}`;
      }
      if (failed.length > 0) {
        text += `\n${failed.length} failed:`;
        for (const f of failed) text += `\n  ${f.error}`;
      }
      text += `\n\nSwitch to a sub-agent: Ctrl+B <window-number>`;
      text += `\nShared run directory: ${batchRunDir}`;

      return {
        content: [{ type: "text" as const, text }],
        details: {
          action: "spawn",
          spawn: spawned,
        } as ToolDetails,
      };
    }

    // Single spawn — agent is optional (defaults to worker)
    if (!params.task) {
      return {
        content: [
          {
            type: "text" as const,
            text: "spawn requires a 'task' parameter (or 'tasks' array for multi-spawn)",
          },
        ],
        isError: true,
        details: { action: "spawn", error: "Missing parameters" } as ToolDetails,
      };
    }

    if (tracked.size >= MAX_AGENTS) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Max ${MAX_AGENTS} concurrent sub-agents. Kill some first.`,
          },
        ],
        isError: true,
        details: { action: "spawn", error: "Max agents reached" } as ToolDetails,
      };
    }

    const runId = shortId();
    const runDir = path.join(RUN_DIR_BASE, runId);
    fs.mkdirSync(path.join(runDir, "shared"), { recursive: true });

    const result = spawnOne(
      params.agent,
      params.task,
      params.name,
      params.cwd ?? ctx.cwd,
      agents,
      runDir,
    );

    if (result.error) {
      return {
        content: [{ type: "text" as const, text: result.error }],
        isError: true,
        details: { action: "spawn", error: result.error } as ToolDetails,
      };
    }

    ensurePoller();
    updateWidget();
    broadcastRoster();

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Spawned sub-agent in tmux window "${result.windowName}".\n` +
            `  id: ${result.id}\n` +
            `  result file: ${result.resultFile}\n` +
            `  run directory: ${runDir}\n\n` +
            `The user can switch to it via tmux.\n` +
            `Check status: tmux_subagent({ action: "check", id: "${result.id}" })\n` +
            `Collect result: tmux_subagent({ action: "collect", id: "${result.id}" })`,
        },
      ],
      details: { action: "spawn", spawn: result } as ToolDetails,
    };
  }

  function spawnOne(
    agentName: string | undefined,
    task: string,
    windowName: string | undefined,
    cwd: string,
    agents: any[],
    runDir: string,
  ): any {
    // Resolve agent: try exact match, then fall back to "worker", then first available
    let agentConfig = agents.find((a: any) => a.name === agentName);
    if (!agentConfig && agentName) {
      const available = agents.map((a: any) => a.name).join(", ") || "none";
      return { error: `Unknown agent: "${agentName}". Available: ${available}` };
    }
    if (!agentConfig) {
      agentConfig = agents.find((a: any) => a.name === "worker") || agents[0];
    }
    if (!agentConfig) {
      return { error: "No agent definitions found. Create .md files in ~/.pi/agent/agents/" };
    }

    const resolvedAgentName = agentConfig.name;
    const id = shortId();
    const agentDir = path.join(runDir, `${resolvedAgentName}-${id}`);
    const resultFile = path.join(agentDir, agentConfig.output || "result.md");
    const promptFile = path.join(agentDir, "prompt.md");
    const sessionDir = path.join(agentDir, "session");

    fs.mkdirSync(sessionDir, { recursive: true });

    // Replace {run_dir} in task
    const resolvedTask = task.replace(/\{run_dir\}/g, runDir);

    // Write system prompt
    const systemPrompt = buildSystemPrompt(agentConfig, resultFile, agentDir);
    fs.writeFileSync(promptFile, systemPrompt, "utf-8");

    // Build pi command — interactive mode (full TUI) with initial prompt.
    // The user can switch to this tmux window and interact directly.
    const piArgs: string[] = [];
    piArgs.push("--append-system-prompt", promptFile);
    piArgs.push("--session-dir", sessionDir);
    if (agentConfig.model) piArgs.push("--model", agentConfig.model);
    if (agentConfig.tools?.length) {
      piArgs.push("--tools", agentConfig.tools.join(","));
    }
    const socketPath = ensureTeamServer();
    piArgs.push("--agentic-team-socket", socketPath);
    piArgs.push("--agentic-team-id", id);
    piArgs.push(resolvedTask);

    // Interactive mode: pi starts its TUI, processes the prompt, then waits
    // for user input. The user can switch to this tmux window at any time.
    const shellCmd = `cd ${shellEscape(cwd)} && exec pi ${piArgs.map(shellEscape).join(" ")}`;

    const wName = windowName || `${resolvedAgentName}-${id.slice(0, 4)}`;

    try {
      tmux.createWindow(tmuxSession!, wName, shellCmd);
    } catch (err: any) {
      return { error: `Failed to create tmux window: ${err.message}` };
    }

    const entry: TrackedAgent = {
      id,
      agent: resolvedAgentName,
      task: resolvedTask,
      windowIndex: -1, // deprecated — we use windowName for targeting
      windowName: wName,
      runDir: agentDir,
      resultFile,
      promptFile,
      sessionDir,
      startTime: Date.now(),
      status: "running",
      cwd,
    };
    tracked.set(id, entry);

    return {
      id,
      windowIndex: -1,
      windowName: wName,
      runDir: agentDir,
      resultFile,
    };
  }

  async function handleWait(params: any, signal?: AbortSignal) {
    const timeoutSec = params.timeout ?? 120;
    const pollMs = 2000;
    const deadline = Date.now() + timeoutSec * 1000;

    // Determine which agents to wait for: specific id, or all running
    let waitFor: TrackedAgent[];
    if (params.id) {
      const agent = findAgent(params.id);
      if (!agent) {
        return {
          content: [{ type: "text" as const, text: `No agent found with id "${params.id}"` }],
          isError: true,
          details: { action: "wait", error: "Agent not found" } as ToolDetails,
        };
      }
      waitFor = [agent];
    } else {
      waitFor = Array.from(tracked.values()).filter(
        (a) => a.status === "running",
      );
    }

    if (waitFor.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No running agents to wait for." }],
        details: { action: "wait" } as ToolDetails,
      };
    }

    const names = waitFor.map((a) => `${a.agent}-${a.id.slice(0, 4)}`).join(", ");

    // Poll until all done, timeout, or a sub-agent asks a question
    let wokeForAsks = false;
    while (Date.now() < deadline) {
      if (signal?.aborted) break;
      refreshStatuses();
      updateWidget();

      const stillRunning = waitFor.filter((a) => a.status === "running");
      if (stillRunning.length === 0) break;

      if (pendingAsks.length > 0 || pendingPeerMessages.length > 0) {
        wokeForAsks = pendingAsks.length > 0;
        break;
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        wakeWaiters = () => { clearTimeout(timer); resolve(); };
      });
      wakeWaiters = null;
    }

    refreshStatuses();
    updateWidget();

    const statusLines = waitFor.map((a) => {
      const elapsed = formatDuration((a.endTime ?? Date.now()) - a.startTime);
      const icon =
        a.status === "done" ? "✓" : a.status === "failed" ? "✗" : a.status === "lost" ? "?" : "⏳";
      return `${icon} ${a.agent}-${a.id.slice(0, 4)}: ${a.status} (${elapsed})`;
    });

    const allDone = waitFor.every((a) => a.status !== "running");
    const doneCount = waitFor.filter((a) => a.status === "done").length;

    const peerMessages = pendingPeerMessages.splice(0);
    const asks = pendingAsks.splice(0);

    let text: string;
    if (wokeForAsks) {
      text = "Agent(s) need attention:\n";
      for (const a of asks) text += `  ${a.label}: ${a.question}\n`;
      text += "\nRespond via steer action.\n";
    } else if (allDone) {
      text = `All ${waitFor.length} agent(s) finished (${doneCount} succeeded).\n`;
    } else {
      text = `Timed out after ${timeoutSec}s. Some agents still running.\n`;
    }
    text += statusLines.join("\n");
    if (peerMessages.length > 0) {
      text += "\n\nAgent chatter during wait:\n";
      for (const m of peerMessages) text += `  💬 ${m.from} → ${m.to}: ${m.message}\n`;
    }
    if (doneCount > 0) text += "\n\nUse collect to get results from finished agents.";

    return {
      content: [{ type: "text" as const, text }],
      details: { action: "wait", agents: waitFor } as ToolDetails,
    };
  }

  function handleCheck(params: any) {
    const id = params.id;
    if (!id) {
      return {
        content: [{ type: "text" as const, text: "check requires 'id' parameter" }],
        isError: true,
        details: { action: "check", error: "Missing id" } as ToolDetails,
      };
    }

    const agent = findAgent(id);
    if (!agent) {
      return {
        content: [{ type: "text" as const, text: `No agent found with id "${id}"` }],
        isError: true,
        details: { action: "check", error: "Agent not found" } as ToolDetails,
      };
    }

    if (tmuxSession) {
      refreshStatuses();
      updateWidget();
    }

    const elapsed = formatDuration(Date.now() - agent.startTime);
    let text = `Agent ${agent.agent}-${agent.id.slice(0, 4)}: ${agent.status} (${elapsed})\n`;
    text += `  tmux window: ${agent.windowName}\n`;
    text += `  result file: ${agent.resultFile}\n`;

    const checkResult: any = {
      id: agent.id,
      status: agent.status,
      elapsed,
    };

    if (agent.status === "running" && tmuxSession) {
      const paneOutput = tmux.capturePaneOutput(
        tmuxSession,
        agent.windowName,
        PANE_CAPTURE_LINES,
      );
      if (paneOutput) {
        text += `\nLast ${PANE_CAPTURE_LINES} lines of output:\n${paneOutput}`;
        checkResult.paneOutput = paneOutput;
      }
    }

    if (agent.status === "done" && fs.existsSync(agent.resultFile)) {
      try {
        const content = fs.readFileSync(agent.resultFile, "utf-8");
        const preview = content
          .split("\n")
          .slice(0, RESULT_PREVIEW_LINES)
          .join("\n");
        text += `\nResult preview (first ${RESULT_PREVIEW_LINES} lines):\n${preview}`;
        checkResult.resultPreview = preview;
      } catch { /* ignore */ }
    }

    return {
      content: [{ type: "text" as const, text }],
      details: { action: "check", check: checkResult } as ToolDetails,
    };
  }

  function handleCollect(params: any) {
    const id = params.id;
    if (!id) {
      return {
        content: [{ type: "text" as const, text: "collect requires 'id' parameter" }],
        isError: true,
        details: { action: "collect", error: "Missing id" } as ToolDetails,
      };
    }

    const agent = findAgent(id);
    if (!agent) {
      return {
        content: [{ type: "text" as const, text: `No agent found with id "${id}"` }],
        isError: true,
        details: { action: "collect", error: "Agent not found" } as ToolDetails,
      };
    }

    if (tmuxSession) refreshStatuses();

    if (agent.status === "running") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Agent ${agent.agent}-${agent.id.slice(0, 4)} is still running. Use check to monitor, or wait and try again.`,
          },
        ],
        details: { action: "collect", error: "Still running" } as ToolDetails,
      };
    }

    if (!fs.existsSync(agent.resultFile)) {
      let fallback = "";
      if (tmuxSession) {
        fallback = tmux.capturePaneOutput(tmuxSession, agent.windowName, 100);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: fallback
              ? `No result file found. Agent pane output:\n${fallback}`
              : `No result file found at ${agent.resultFile}. Agent may have failed without writing output.`,
          },
        ],
        isError: agent.status === "failed",
        details: { action: "collect", result: fallback || undefined } as ToolDetails,
      };
    }

    try {
      const raw = fs.readFileSync(agent.resultFile, "utf-8");
      const result = truncateResult(raw);
      return {
        content: [
          { type: "text" as const, text: result },
          {
            type: "text" as const,
            text: `[DO NOT AUTO-KILL] The tmux window "${agent.windowName}" is still open. ` +
              `You MUST ask the user before closing it — they may want to continue interacting with this sub-agent. ` +
              `To close: tmux_subagent({ action: "kill", id: "${agent.id}" })`,
          },
        ],
        details: { action: "collect", result } as ToolDetails,
      };
    } catch (err: any) {
      return {
        content: [
          { type: "text" as const, text: `Failed to read result: ${err.message}` },
        ],
        isError: true,
        details: { action: "collect", error: err.message } as ToolDetails,
      };
    }
  }

  function handleKill(params: any) {
    const id = params.id;
    if (!id) {
      return {
        content: [{ type: "text" as const, text: "kill requires 'id' parameter" }],
        isError: true,
        details: { action: "kill", error: "Missing id" } as ToolDetails,
      };
    }

    const agent = findAgent(id);
    if (!agent) {
      return {
        content: [{ type: "text" as const, text: `No agent found with id "${id}"` }],
        isError: true,
        details: { action: "kill", error: "Agent not found" } as ToolDetails,
      };
    }

    if (tmuxSession) {
      tmux.killWindow(tmuxSession, agent.windowName);
    }

    tracked.delete(agent.id);
    updateWidget();

    return {
      content: [
        {
          type: "text" as const,
          text: `Killed agent ${agent.agent}-${agent.id.slice(0, 4)} (window "${agent.windowName}")`,
        },
      ],
      details: { action: "kill" } as ToolDetails,
    };
  }

  function handleList() {
    if (tmuxSession) {
      refreshStatuses();
    }

    const agentList = Array.from(tracked.values());

    if (agentList.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No active sub-agents." }],
        details: { action: "list", agents: [] } as ToolDetails,
      };
    }

    const lines = agentList.map((a) => {
      const elapsed = formatDuration((a.endTime ?? Date.now()) - a.startTime);
      const icon =
        a.status === "done" ? "✓" : a.status === "failed" ? "✗" : a.status === "lost" ? "?" : "⏳";
      return `${icon} ${a.id} [${a.windowName}] ${a.agent}  ${a.status}  ${elapsed}  result: ${a.resultFile}`;
    });

    const finished = agentList.filter((a) => a.status === "done" || a.status === "failed" || a.status === "lost");
    let text = lines.join("\n");
    if (finished.length > 0) {
      text += `\n\n${finished.length} finished agent(s) still have tmux windows open. ` +
        `Ask the user if they want to clean them up (kill the tmux windows).`;
    }

    return {
      content: [{ type: "text" as const, text }],
      details: { action: "list", agents: agentList } as ToolDetails,
    };
  }

  function handleSteer(params: any) {
    if (!params.id || !params.message) {
      return {
        content: [{ type: "text" as const, text: "steer requires 'id' and 'message' parameters" }],
        isError: true,
        details: { action: "steer", error: "Missing parameters" } as ToolDetails,
      };
    }

    const agent = findAgent(params.id);
    if (!agent) {
      return {
        content: [{ type: "text" as const, text: `No agent found with id "${params.id}"` }],
        isError: true,
        details: { action: "steer", error: "Agent not found" } as ToolDetails,
      };
    }

    if (!teamServer) {
      return {
        content: [{ type: "text" as const, text: "No team server running" }],
        isError: true,
        details: { action: "steer", error: "No server" } as ToolDetails,
      };
    }

    const deliverAs: DeliverAs = params.deliverAs ?? "steer";
    if (!teamServer.steer(agent.id, params.message, deliverAs)) {
      return {
        content: [{
          type: "text" as const,
          text: `Agent ${agent.agent}-${agent.id.slice(0, 4)} is not connected to the team socket`,
        }],
        isError: true,
        details: { action: "steer", error: "Agent not connected" } as ToolDetails,
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: `Steered ${agent.agent}-${agent.id.slice(0, 4)} (${deliverAs}): ${params.message}`,
      }],
      details: { action: "steer" } as ToolDetails,
    };
  }

  // ── Find agent by id (prefix match) ──

  function findAgent(id: string): TrackedAgent | undefined {
    if (tracked.has(id)) return tracked.get(id);
    for (const agent of tracked.values()) {
      if (agent.id.startsWith(id)) return agent;
    }
    for (const agent of tracked.values()) {
      if (agent.windowName === id) return agent;
    }
    return undefined;
  }

  // ── Cleanup on session end ──

  pi.on("session_shutdown", () => {
    if (poller) {
      clearInterval(poller);
      poller = null;
    }
    tracked.clear();
    if (lastCtx?.hasUI) {
      lastCtx.ui.setWidget(WIDGET_KEY, undefined);
    }
    teamServer?.close();
    teamServer = null;
    teamClient?.close();
    teamClient = null;
    teamSocketPath = null;
  });

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    cleanupOldRunDirs();

    const socketPath = pi.getFlag("agentic-team-socket");
    const agentId = pi.getFlag("agentic-team-id");
    if (typeof socketPath === "string" && typeof agentId === "string") {
      teamSocketPath = socketPath;
      teamClient = new TeamClient(
        socketPath,
        agentId,
        (message, deliverAs) => {
          pi.sendMessage(
            { customType: "supervisor-steer", content: message, display: true },
            { triggerTurn: true, deliverAs },
          );
        },
        (from, message) => {
          incomingMessages.push(`${from.slice(0, 4)}: ${message}`);
          hasUnreadMessage = true;
          messageWakeup?.();
          messageWakeup = null;
        },
      );
    }
  });

  // ── Cleanup old run directories (older than 24h) ──

  function cleanupOldRunDirs(): void {
    const maxAgeMs = 24 * 60 * 60 * 1000;
    const now = Date.now();

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(RUN_DIR_BASE, { withFileTypes: true });
    } catch {
      return; // Directory doesn't exist yet — nothing to clean
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(RUN_DIR_BASE, entry.name);
      try {
        const stat = fs.statSync(dirPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore errors — dir may have been removed by another process
      }
    }
  }
}
