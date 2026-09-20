/**
 * Session Meter
 *
 * Status-row indicator of current session age: `1h42m`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "session-meter";

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
	ctx.ui.setStatus(STATUS_KEY, theme.fg("muted", age));
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
