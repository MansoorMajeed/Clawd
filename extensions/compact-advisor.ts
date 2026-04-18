/**
 * Compact Advisor
 *
 * Suggests compaction when context usage exceeds a threshold.
 * Prompts the user for confirmation, then triggers compaction with
 * task-aware instructions that preserve current work context.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const THRESHOLD_TOKENS = 150_000;
const COOLDOWN_MS = 5 * 60 * 1000;

export default function (pi: ExtensionAPI) {
	let lastSuggested = 0;

	pi.on("agent_end", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens < THRESHOLD_TOKENS) return;

		const now = Date.now();
		if (now - lastSuggested < COOLDOWN_MS) return;
		lastSuggested = now;

		const confirmed = await ctx.ui.confirm(
			"Context getting large",
			`At ${Math.round(usage.tokens / 1000)}k tokens. Compact now? This preserves your current task context.`
		);
		if (!confirmed) return;

		ctx.compact({
			customInstructions:
				"Preserve the current task context and any in-progress work. Focus the summary on what's actively being worked on, key decisions made, and what's next.",
		});
	});
}
