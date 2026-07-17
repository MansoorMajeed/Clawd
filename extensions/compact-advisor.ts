/**
 * Compact Advisor
 *
 * Silent quality-ceiling autocompaction. Treats ~200k as a soft ceiling: let
 * the active run finish, then compact while idle. If a continuing run reaches
 * ~250k, compact at the next legal boundary so quality cannot drift forever.
 *
 * Fires on turn_end (per LLM round-trip) so it triggers mid-run during long
 * autonomous tasks, not just at the end of a user prompt. Native auto-compaction
 * stays enabled as the overflow safety net.
 *
 * Pi cannot compact when an oversized trailing tool result leaves no legal cut
 * point. Preflight the same cut-point rules before calling ctx.compact(), because
 * ctx.compact() aborts the active run even when preparation subsequently fails.
 * Hard-ceiling compaction resumes interrupted tool runs after completion.
 */

import {
	findCutPoint,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const TARGET_TOKENS = 200_000;
export const HARD_TARGET_TOKENS = 250_000;
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

export function computeHardCompactThreshold(contextWindow: number): number {
	return Math.min(HARD_TARGET_TOKENS, contextWindow - RESERVE_MARGIN);
}

export function shouldCompactAtBoundary(
	tokens: number,
	contextWindow: number,
	settled: boolean,
	midTask: boolean,
): boolean {
	if (settled) return tokens >= computeCompactThreshold(contextWindow);
	return midTask && tokens >= computeHardCompactThreshold(contextWindow);
}

export function isCompactionReady(entries: SessionEntry[], keepRecentTokens: number): boolean {
	if (entries.length === 0 || entries[entries.length - 1].type === "compaction") return false;

	let boundaryStart = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction") continue;
		const firstKeptIndex = entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
		boundaryStart = firstKeptIndex >= 0 ? firstKeptIndex : i + 1;
		break;
	}

	const cutPoint = findCutPoint(entries, boundaryStart, entries.length, keepRecentTokens);
	if (!entries[cutPoint.firstKeptEntryIndex]?.id) return false;

	// Pi compacts both the history before a split turn and the discarded turn
	// prefix. Together those ranges cover boundaryStart..firstKeptEntryIndex.
	for (let i = boundaryStart; i < cutPoint.firstKeptEntryIndex; i++) {
		const entry = entries[i];
		if (
			entry.type === "message" ||
			entry.type === "custom_message" ||
			(entry.type === "branch_summary" && !!entry.summary)
		) {
			return true;
		}
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	let compacting = false;
	const terminatingToolCallIds = new Set<string>();

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

	function compactIfReady(midTask: boolean, ctx: ExtensionContext): void {
		if (compacting) return;

		const settings = SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionSettings();
		const entries = ctx.sessionManager.getBranch();
		if (!isCompactionReady(entries, settings.keepRecentTokens)) return;

		compacting = true;
		ctx.compact({
			customInstructions: COMPACT_INSTRUCTIONS,
			onComplete: () => {
				compacting = false;
				resumeIfInterrupted(midTask, ctx);
			},
			onError: (error) => {
				compacting = false;
				if (midTask && error.message.includes("Nothing to compact")) resumeIfInterrupted(true, ctx);
			},
		});
	}

	pi.on("turn_start", () => {
		terminatingToolCallIds.clear();
	});

	pi.on("tool_execution_end", (event) => {
		if (event.result?.terminate === true) terminatingToolCallIds.add(event.toolCallId);
		else terminatingToolCallIds.delete(event.toolCallId);
	});

	pi.on("turn_end", (event, ctx) => {
		if (compacting) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null) return;

		const allToolsTerminate =
			event.toolResults.length > 0 &&
			event.toolResults.every((result) => terminatingToolCallIds.has(result.toolCallId));
		const midTask = event.toolResults.length > 0 && !allToolsTerminate;
		if (!shouldCompactAtBoundary(usage.tokens, usage.contextWindow, false, midTask)) return;
		compactIfReady(true, ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (compacting || !ctx.isIdle() || ctx.hasPendingMessages()) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null) return;
		if (!shouldCompactAtBoundary(usage.tokens, usage.contextWindow, true, false)) return;
		compactIfReady(false, ctx);
	});
}
