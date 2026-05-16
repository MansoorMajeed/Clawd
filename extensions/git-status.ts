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

export type DirtyCounts = {
	modified: number;
	added: number;
	deleted: number;
	untracked: number;
	unmerged: number;
};

function run(cwd: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS }, (err, stdout) => {
			if (err) return resolve(null);
			resolve(stdout);
		});
	});
}

/**
 * Parses `git status --porcelain` output into bucketed counts.
 *
 * Porcelain v1 emits two-char XY codes per entry. We classify them in
 * priority order so the indicator never renders clean on a dirty tree:
 *   - `!!` ignored        → skipped
 *   - `??` untracked      → untracked
 *   - any `U`/`AA`/`DD`   → unmerged (conflict)
 *   - any M/R/C/T         → modified (content/path change)
 *   - any A               → added
 *   - any D               → deleted
 *   - anything else       → unmerged (catch-all so unknown codes surface)
 */
export function parseStatus(out: string): DirtyCounts {
	const counts: DirtyCounts = {
		modified: 0,
		added: 0,
		deleted: 0,
		untracked: 0,
		unmerged: 0,
	};
	for (const line of out.split("\n")) {
		if (line.length < 2) continue;
		const code = line.slice(0, 2);
		if (code === "!!") continue;
		if (code === "??") {
			counts.untracked++;
			continue;
		}
		if (code.includes("U") || code === "AA" || code === "DD") {
			counts.unmerged++;
			continue;
		}
		if (
			code.includes("M") ||
			code.includes("R") ||
			code.includes("C") ||
			code.includes("T")
		) {
			counts.modified++;
			continue;
		}
		if (code.includes("A")) {
			counts.added++;
			continue;
		}
		if (code.includes("D")) {
			counts.deleted++;
			continue;
		}
		counts.unmerged++;
	}
	return counts;
}

export function isDirty(counts: DirtyCounts): boolean {
	return (
		counts.modified +
			counts.added +
			counts.deleted +
			counts.untracked +
			counts.unmerged >
		0
	);
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

export function formatDirty(counts: DirtyCounts): string {
	const parts: string[] = [];
	if (counts.modified) parts.push(`${counts.modified}M`);
	if (counts.added) parts.push(`${counts.added}A`);
	if (counts.deleted) parts.push(`${counts.deleted}D`);
	if (counts.untracked) parts.push(`${counts.untracked}?`);
	if (counts.unmerged) parts.push(`${counts.unmerged}U`);
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

// Monotonic id so that an older, slower probe cannot overwrite a newer
// result. Lifecycle events fan-out to async git probes; without this the
// statusline can be stamped with stale state when probes finish out of order.
let renderSeq = 0;
let appliedSeq = 0;

async function render(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const mySeq = ++renderSeq;
	const result = await compute(ctx.cwd);
	if (!ctx.hasUI) return; // bail if UI torn down meanwhile
	if (mySeq < appliedSeq) return; // a newer probe already applied
	appliedSeq = mySeq;
	if (!result) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const theme = ctx.ui.theme;
	const { counts, sinceCommit } = result;
	const dirty = isDirty(counts);

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
	pi.on("turn_end", (_event, ctx) => fire(ctx));
	pi.on("agent_end", (_event, ctx) => fire(ctx));
	pi.on("session_compact", (_event, ctx) => fire(ctx));
	pi.on("session_switch", (_event, ctx) => fire(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
