/**
 * Shared types for the tmux-subagent extension
 */

export type AgentScope = "user" | "project" | "both";

export type SubagentStatus = "running" | "done" | "failed" | "lost";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  output?: string;       // default output filename
  source: "user" | "project";
  filePath: string;
}

export interface TrackedAgent {
  id: string;                // short hex id (e.g., "a3b1c2d4")
  agent: string;             // agent definition name (e.g., "scout")
  task: string;              // original task text
  windowIndex: number;       // tmux window index
  windowName: string;        // tmux window name
  runDir: string;            // /tmp/pi-tmux-runs/{runId}/{agentName}-{id}/
  resultFile: string;        // path to result.md
  promptFile: string;        // path to injected system prompt
  sessionDir: string;        // path to pi session directory
  startTime: number;         // Date.now() at spawn
  endTime?: number;          // Date.now() when status changed to done/failed/lost
  status: SubagentStatus;
  statusText?: string;        // agent-reported status for widget display
  cwd: string;               // working directory
}

export interface SpawnResult {
  id: string;
  windowIndex: number;
  windowName: string;
  runDir: string;
  resultFile: string;
}

export interface CheckResult {
  id: string;
  status: SubagentStatus;
  elapsed: string;
  paneOutput?: string;       // last N lines of tmux pane (if running)
  resultPreview?: string;    // first N lines of result.md (if done)
}

export interface ToolDetails {
  action: string;
  agents?: TrackedAgent[];
  spawn?: SpawnResult | SpawnResult[];
  check?: CheckResult;
  result?: string;
  error?: string;
}

export const RUN_DIR_BASE = "/tmp/pi-tmux-runs";
export const MAX_AGENTS = 8;
export const POLL_INTERVAL_MS = 1000;
export const WIDGET_KEY = "tmux-subagents";
export const PANE_CAPTURE_LINES = 20;
export const RESULT_PREVIEW_LINES = 50;
export const MAX_RESULT_BYTES = 200 * 1024;
export const MAX_RESULT_LINES = 5000;
