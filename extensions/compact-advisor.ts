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
 *
 * Resumes after compacting: a proactive compaction ends the in-flight agent loop
 * with nothing to restart it (pi only auto-retries on genuine overflow recovery,
 * not on threshold compaction). If the interrupted turn was mid-task (had tool
 * calls), we nudge the agent to continue so long autonomous runs don't stall.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TARGET_TOKENS = 200_000;
export const RESERVE_MARGIN = 32_000;

const COMPACT_INSTRUCTIONS =
	"Preserve the current task context and any in-progress work. Focus the summary on what's actively being worked on, key decisions made, and what's next.";

const RESUME_PROMPT =
	"Context was just compacted. Continue the in-progress task from where you left off based on the summary — do not restart from scratch.";

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

	function resumeIfInterrupted(midTask: boolean, ctx: ExtensionContext): void {
		if (!midTask) return;
		// If something is already streaming or queued (e.g. loop.ts re-triggered on
		// agent_end), don't double-fire — whoever queued first wins.
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		pi.sendMessage(
			{ customType: "resume", content: RESUME_PROMPT, display: false },
			{ deliverAs: "followUp", triggerTurn: true },
		);
		if (ctx.hasUI) ctx.ui.notify("Resumed after compaction", "info");
	}

	pi.on("turn_end", async (event, ctx) => {
		if (compacting) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null) return;

		if (usage.tokens < computeCompactThreshold(usage.contextWindow)) return;

		// The turn made tool calls => the agent intended to keep working, so the
		// compaction is interrupting a mid-task run and we should resume it. A
		// text-only turn means the agent was finishing; let it go idle.
		const midTask = event.toolResults.length > 0;

		compacting = true;
		ctx.compact({
			customInstructions: COMPACT_INSTRUCTIONS,
			onComplete: () => {
				compacting = false;
				resumeIfInterrupted(midTask, ctx);
			},
			onError: () => {
				compacting = false;
			},
		});
	});
}
