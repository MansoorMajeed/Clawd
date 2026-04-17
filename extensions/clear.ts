/**
 * Clear Extension — Reset conversation to a blank slate
 *
 * Registers /clear command that rewinds the session to its initial state,
 * like Claude Code's built-in /clear. The session file is preserved but
 * all conversation history is removed.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("clear", {
		description: "Clear conversation history and start fresh",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();

			if (branch.length === 0) {
				ctx.ui.notify("Nothing to clear.", "info");
				return;
			}

			const firstEntry = branch[0];
			if (!firstEntry || !("id" in firstEntry)) {
				// No entries with IDs — start a new session instead
				const result = await ctx.newSession({});
				if (result.cancelled) {
					ctx.ui.notify("Cancelled.", "info");
				}
				return;
			}

			try {
				const sessionManager = ctx.sessionManager as unknown as { rewindTo(id: string): void };
				sessionManager.rewindTo(firstEntry.id as string);
				ctx.ui.notify("Conversation cleared.", "info");
			} catch {
				// Fallback: create a new session if rewindTo isn't available
				const result = await ctx.newSession({});
				if (!result.cancelled) {
					ctx.ui.notify("Started fresh session.", "info");
				}
			}
		},
	});
}
