/**
 * Split-Fork Extension — Fork session into a new pane
 *
 * Detects the current multiplexer (zellij, tmux, Ghostty) and opens a new
 * pane/split with a forked Pi session. Adapted from mitsuhiko/agent-stuff
 * with zellij and tmux support added.
 *
 * Priority: zellij > tmux > Ghostty (AppleScript, macOS only)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

type Multiplexer = "zellij" | "tmux" | "ghostty" | null;

function detectMultiplexer(): Multiplexer {
	if (process.env.ZELLIJ_SESSION_NAME) return "zellij";
	if (process.env.TMUX) return "tmux";
	if (process.platform === "darwin") return "ghostty";
	return null;
}

const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			try
				set frontWindow to front window
				set targetTerminal to focused terminal of selected tab of frontWindow
				split targetTerminal direction right with configuration cfg
			on error
				new window with configuration cfg
			end try
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript];
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return [process.execPath];
	}

	return ["pi"];
}

function buildPiCommand(sessionFile: string | undefined, prompt: string): string {
	const commandParts = [...getPiInvocationParts()];

	if (sessionFile) {
		commandParts.push("--session", sessionFile);
	}

	if (prompt.length > 0) {
		commandParts.push("--", prompt);
	}

	return commandParts.map(shellQuote).join(" ");
}

async function createForkedSession(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionDir = path.dirname(sessionFile);
	const branchEntries = ctx.sessionManager.getBranch();
	const currentHeader = ctx.sessionManager.getHeader();

	const timestamp = new Date().toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const newSessionId = randomUUID();
	const newSessionFile = path.join(sessionDir, `${fileTimestamp}_${newSessionId}.jsonl`);

	const newHeader = {
		type: "session",
		version: currentHeader?.version ?? 3,
		id: newSessionId,
		timestamp,
		cwd: currentHeader?.cwd ?? ctx.cwd,
		parentSession: sessionFile,
	};

	const lines = [JSON.stringify(newHeader), ...branchEntries.map((entry) => JSON.stringify(entry))].join("\n") + "\n";

	await fs.mkdir(sessionDir, { recursive: true });
	await fs.writeFile(newSessionFile, lines, "utf8");

	return newSessionFile;
}

async function splitZellij(cwd: string, command: string): Promise<{ ok: boolean; error?: string }> {
	try {
		execSync(`zellij action new-pane --direction right -- bash -c ${shellQuote(`cd ${shellQuote(cwd)} && ${command}`)}`, {
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { ok: true };
	} catch (err: any) {
		return { ok: false, error: err.stderr?.toString()?.trim() || err.message };
	}
}

async function splitTmux(cwd: string, command: string): Promise<{ ok: boolean; error?: string }> {
	try {
		execSync(`tmux split-window -h -c ${shellQuote(cwd)} ${shellQuote(command)}`, {
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { ok: true };
	} catch (err: any) {
		return { ok: false, error: err.stderr?.toString()?.trim() || err.message };
	}
}

async function splitGhostty(pi: ExtensionAPI, cwd: string, startupInput: string): Promise<{ ok: boolean; error?: string }> {
	const result = await pi.exec("osascript", ["-e", GHOSTTY_SPLIT_SCRIPT, "--", cwd, startupInput]);
	if (result.code !== 0) {
		return { ok: false, error: result.stderr?.trim() || result.stdout?.trim() || "osascript error" };
	}
	return { ok: true };
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("split-fork", {
		description: "Fork this session into a new pane (zellij/tmux/Ghostty). Usage: /split-fork [optional prompt]",
		handler: async (args, ctx) => {
			const mux = detectMultiplexer();
			if (!mux) {
				ctx.ui.notify("/split-fork requires zellij, tmux, or macOS Ghostty.", "warning");
				return;
			}

			const wasBusy = !ctx.isIdle();
			const prompt = args.trim();
			const forkedSessionFile = await createForkedSession(ctx);
			const command = buildPiCommand(forkedSessionFile, prompt);

			let result: { ok: boolean; error?: string };

			if (mux === "zellij") {
				result = await splitZellij(ctx.cwd, command);
			} else if (mux === "tmux") {
				result = await splitTmux(ctx.cwd, command);
			} else {
				result = await splitGhostty(pi, ctx.cwd, `${command}\n`);
			}

			if (!result.ok) {
				ctx.ui.notify(`Failed to launch ${mux} split: ${result.error}`, "error");
				if (forkedSessionFile) {
					ctx.ui.notify(`Forked session was created: ${forkedSessionFile}`, "info");
				}
				return;
			}

			if (forkedSessionFile) {
				const fileName = path.basename(forkedSessionFile);
				const suffix = prompt ? " and sent prompt" : "";
				ctx.ui.notify(`Forked to ${fileName} in a new ${mux} split${suffix}.`, "info");
				if (wasBusy) {
					ctx.ui.notify("Forked from current committed state (in-flight turn continues in original session).", "info");
				}
			} else {
				ctx.ui.notify(`Opened a new ${mux} split (no persisted session to fork).`, "warning");
			}
		},
	});
}
