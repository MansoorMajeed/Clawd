/**
 * Session Meter
 *
 * Status-row indicator of current session age and cost burn rate:
 *
 *   `1h42m · $0.45/h`
 *
 * Cost is summed from `assistantMessage.usage.cost` across all entries
 * in the current session (same source extensions/context.ts uses). The
 * rate is suppressed for very young sessions (<1 minute) where division
 * yields garbage.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "session-meter";
const MIN_RATE_AGE_MS = 60_000;

function extractCost(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const c = (usage as { cost?: unknown }).cost;
	if (typeof c === "number") return Number.isFinite(c) ? c : 0;
	if (typeof c === "string") {
		const n = Number(c);
		return Number.isFinite(n) ? n : 0;
	}
	if (c && typeof c === "object") {
		const t = (c as { total?: unknown }).total;
		if (typeof t === "number") return Number.isFinite(t) ? t : 0;
		if (typeof t === "string") {
			const n = Number(t);
			return Number.isFinite(n) ? n : 0;
		}
	}
	return 0;
}

function sumSessionCost(ctx: ExtensionContext): number {
	let total = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if ((entry as { type?: string }).type !== "message") continue;
		const msg = (entry as { message?: { role?: string; usage?: unknown } }).message;
		if (!msg || msg.role !== "assistant") continue;
		total += extractCost(msg.usage);
	}
	return total;
}

function formatDuration(ms: number): string {
	if (ms < 60_000) {
		return `${Math.max(0, Math.floor(ms / 1000))}s`;
	}
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMin = minutes - hours * 60;
	if (hours < 24) return remMin > 0 ? `${hours}h${remMin}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const remHours = hours - days * 24;
	return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

function render(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const header = ctx.sessionManager.getHeader();
	if (!header) return;
	const startMs = Date.parse(header.timestamp);
	if (!Number.isFinite(startMs)) return;

	const ageMs = Math.max(0, Date.now() - startMs);
	const age = formatDuration(ageMs);

	const theme = ctx.ui.theme;
	if (ageMs < MIN_RATE_AGE_MS) {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("muted", age));
		return;
	}

	const cost = sumSessionCost(ctx);
	const ratePerHour = cost / (ageMs / 3_600_000);
	const rateText = `$${ratePerHour.toFixed(2)}/h`;
	ctx.ui.setStatus(
		STATUS_KEY,
		`${theme.fg("muted", age)} ${theme.fg("dim", "·")} ${theme.fg("muted", rateText)}`,
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => render(ctx));
	pi.on("turn_end", (_event, ctx) => render(ctx));
	pi.on("agent_end", (_event, ctx) => render(ctx));
	pi.on("session_compact", (_event, ctx) => render(ctx));
	pi.on("session_switch", (_event, ctx) => render(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
