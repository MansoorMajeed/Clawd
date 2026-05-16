/**
 * Git Status
 *
 * Status-row indicator of working tree dirtiness plus time since the
 * last commit:
 *
 *   clean: `git ✓ · 23m`
 *   dirty: `git 3M 2? · 23m`
 *
 * Hidden when cwd is not a git repository. Shells out asynchronously so
 * agent_end is never blocked.
 */

import { execFile } from "child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "git-status";
const GIT_TIMEOUT_MS = 2000;

type DirtyCounts = {
	modified: number;
	added: number;
	deleted: number;
	untracked: number;
};

function run(cwd: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS }, (err, stdout) => {
			if (err) return resolve(null);
			resolve(stdout);
		});
	});
}

function parseStatus(out: string): DirtyCounts {
	const counts: DirtyCounts = { modified: 0, added: 0, deleted: 0, untracked: 0 };
	for (const line of out.split("\n")) {
		if (line.length < 2) continue;
		const code = line.slice(0, 2);
		if (code === "??") counts.untracked++;
		else if (code.includes("M")) counts.modified++;
		else if (code.includes("A")) counts.added++;
		else if (code.includes("D")) counts.deleted++;
	}
	return counts;
}

function formatDuration(ms: number): string {
	if (ms < 60_000) return "now";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const remMin = minutes - hours * 60;
		return remMin > 0 ? `${hours}h${remMin}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const remHours = hours - days * 24;
	return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

function formatDirty(counts: DirtyCounts): string {
	const parts: string[] = [];
	if (counts.modified) parts.push(`${counts.modified}M`);
	if (counts.added) parts.push(`${counts.added}A`);
	if (counts.deleted) parts.push(`${counts.deleted}D`);
	if (counts.untracked) parts.push(`${counts.untracked}?`);
	return parts.join(" ");
}

async function compute(
	cwd: string,
): Promise<{ counts: DirtyCounts; sinceCommit: string | null } | null> {
	const statusOut = await run(cwd, ["status", "--porcelain"]);
	if (statusOut === null) return null; // not a repo or git missing
	const counts = parseStatus(statusOut);

	const logOut = await run(cwd, ["log", "-1", "--format=%ct"]);
	let sinceCommit: string | null = null;
	if (logOut !== null) {
		const ts = parseInt(logOut.trim(), 10);
		if (Number.isFinite(ts)) {
			sinceCommit = formatDuration(Date.now() - ts * 1000);
		}
	}
	return { counts, sinceCommit };
}

async function render(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const result = await compute(ctx.cwd);
	if (!ctx.hasUI) return; // bail if UI torn down meanwhile
	if (!result) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const theme = ctx.ui.theme;
	const { counts, sinceCommit } = result;
	const dirty = counts.modified + counts.added + counts.deleted + counts.untracked > 0;

	const head = dirty ? `git ${formatDirty(counts)}` : theme.fg("success", "git ✓");
	const tail = sinceCommit ? ` ${theme.fg("dim", `· ${sinceCommit}`)}` : "";
	ctx.ui.setStatus(STATUS_KEY, `${dirty ? theme.fg("warning", head) : head}${tail}`);
}

export default function (pi: ExtensionAPI) {
	const fire = (ctx: ExtensionContext) => {
		render(ctx).catch(() => {
			/* swallow */
		});
	};
	pi.on("session_start", (_event, ctx) => fire(ctx));
	pi.on("agent_end", (_event, ctx) => fire(ctx));
	pi.on("session_compact", (_event, ctx) => fire(ctx));
	pi.on("session_switch", (_event, ctx) => fire(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
