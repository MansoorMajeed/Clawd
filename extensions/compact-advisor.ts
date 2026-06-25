/**
 * Compact Advisor
 *
 * Silent context-ceiling autocompaction. Compacts when context usage crosses a
 * working ceiling (~200k), so the agent doesn't degrade on large 1M-window
 * models that would otherwise only compact near overflow (~984k).
 *
 * Fires on turn_end (per LLM round-trip) so it triggers mid-run during long
 * autonomous tasks, not just at the end of a user prompt. Native auto-compaction
 * stays enabled as the overflow safety net.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TARGET_TOKENS = 200_000;
export const RESERVE_MARGIN = 32_000;

const COMPACT_INSTRUCTIONS =
	"Preserve the current task context and any in-progress work. Focus the summary on what's actively being worked on, key decisions made, and what's next.";

/**
 * Effective compaction threshold for a given context window.
 * Caps at TARGET_TOKENS on large windows; on windows near or below the target,
 * fires at `window - RESERVE_MARGIN` so it triggers just before native compaction.
 */
export function computeCompactThreshold(contextWindow: number): number {
	return Math.min(TARGET_TOKENS, contextWindow - RESERVE_MARGIN);
}

export default function (pi: ExtensionAPI) {
	let compacting = false;

	pi.on("turn_end", async (_event, ctx) => {
		if (compacting) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null) return;

		if (usage.tokens < computeCompactThreshold(usage.contextWindow)) return;

		compacting = true;
		ctx.compact({
			customInstructions: COMPACT_INSTRUCTIONS,
			onComplete: () => {
				compacting = false;
			},
			onError: () => {
				compacting = false;
			},
		});
	});
}
