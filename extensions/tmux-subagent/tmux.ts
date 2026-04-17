/**
 * tmux CLI helpers
 *
 * All operations target windows by NAME (not index), because tmux
 * renumbers window indices when other windows close.
 * The tmux target format "session:=name" matches by exact window name.
 */

import { execSync } from "node:child_process";

/**
 * Check if we're running inside tmux.
 */
export function isInsideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

/**
 * Get the current tmux session name.
 */
export function getTmuxSession(): string {
  return execSync("tmux display-message -p '#{session_name}'", {
    encoding: "utf-8",
  }).trim();
}

/**
 * Build a tmux target string that matches a window by exact name.
 * Format: "sessionName:=windowName"
 */
function target(sessionName: string, windowName: string): string {
  return esc(`${sessionName}:=${windowName}`);
}

/**
 * Create a new tmux window running a command.
 * Returns the window name (which is our stable identifier).
 */
export function createWindow(
  sessionName: string,
  windowName: string,
  command: string,
): string {
  // -d: don't switch, -P -F: print window info, -n: set name
  execSync(
    `tmux new-window -d -t ${esc(sessionName + ":")} -n ${esc(windowName)} -P -F '#{window_index}' ${esc(command)}`,
    { encoding: "utf-8" },
  );
  return windowName;
}

/**
 * Check if a tmux window exists and return pane info.
 * Returns null if window doesn't exist.
 */
export function getWindowInfo(
  sessionName: string,
  windowName: string,
): { panePid: number; paneDead: boolean } | null {
  try {
    const output = execSync(
      `tmux list-panes -t ${target(sessionName, windowName)} -F '#{pane_pid} #{pane_dead}'`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!output) return null;
    const [pidStr, deadStr] = output.split(" ");
    return {
      panePid: parseInt(pidStr, 10),
      paneDead: deadStr === "1",
    };
  } catch {
    return null;
  }
}

/**
 * Capture the last N lines from a tmux pane.
 */
export function capturePaneOutput(
  sessionName: string,
  windowName: string,
  lines: number,
): string {
  try {
    return execSync(
      `tmux capture-pane -p -J -t ${target(sessionName, windowName)} -S -${lines}`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch {
    return "";
  }
}

/**
 * Kill a tmux window by name.
 */
export function killWindow(
  sessionName: string,
  windowName: string,
): boolean {
  try {
    execSync(
      `tmux kill-window -t ${target(sessionName, windowName)}`,
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Shell-escape a string for use in tmux commands.
 */
function esc(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
