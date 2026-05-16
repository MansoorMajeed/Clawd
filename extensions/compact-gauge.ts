/**
 * Compact Gauge
 *
 * Status-row indicator of context usage against a personal compaction
 * threshold (150k tokens), separate from pi's built-in "% of model max"
 * gauge. Format: `compact 8% (12k/150k)`.
 *
 * Colors:
 *   <60%        default
 *   60%–85%     yellow  (warning)
 *   85%–100%    red     (error)
 *   >=100%      bright red (bold error) — does not cap
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const THRESHOLD_TOKENS = 150_000;
const STATUS_KEY = "compact-gauge";

function formatStatus(tokens: number, ctx: ExtensionContext): string {
	const pct = (tokens / THRESHOLD_TOKENS) * 100;
	const kTokens = Math.round(tokens / 1000);
	const kThreshold = Math.round(THRESHOLD_TOKENS / 1000);
	const text = `compact ${Math.round(pct)}% (${kTokens}k/${kThreshold}k)`;

	const theme = ctx.ui.theme;
	if (pct >= 100) return theme.bold(theme.fg("error", text));
	if (pct >= 85) return theme.fg("error", text);
	if (pct >= 60) return theme.fg("warning", text);
	return text;
}

function render(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const usage = ctx.getContextUsage();
	if (!usage) return;
	ctx.ui.setStatus(STATUS_KEY, formatStatus(usage.tokens, ctx));
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
