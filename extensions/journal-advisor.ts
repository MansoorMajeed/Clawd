/**
 * Journal Advisor
 *
 * Nudges the agent to capture decisions, surprises, and dead-ends via
 * `journal_append` when an AI-Knowledge task is active.
 *
 * Fires when context tokens have grown by THRESHOLD_TOKENS since the last
 * reminder or last journal entry. The reminder is permissive ("ignore this
 * if nothing applies") to avoid pro-forma journaling.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getCurrentTask } from "./ai-knowledge/state.js";

const THRESHOLD_TOKENS = 50_000;

export default function (pi: ExtensionAPI) {
	let lastFireTokens = 0;

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "journal_append") return;
		const usage = ctx.getContextUsage();
		if (usage) lastFireTokens = usage.tokens;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const task = getCurrentTask();
		if (!task) return;

		const usage = ctx.getContextUsage();
		if (!usage) return;
		if (usage.tokens - lastFireTokens < THRESHOLD_TOKENS) return;

		lastFireTokens = usage.tokens;

		return {
			message: {
				customType: "journal-advisor",
				content:
					`Reminder: AI-Knowledge task \`${task.project}/${task.task}\` is active. ` +
					"If you've made a non-trivial decision, hit a surprise, or ruled out a path " +
					"since the last journal entry, capture it now with `journal_append`. " +
					"If nothing applies, ignore this — don't journal for the sake of it.",
				display: true,
			},
		};
	});
}
