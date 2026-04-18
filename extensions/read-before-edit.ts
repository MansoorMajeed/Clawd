/**
 * Read-Before-Edit Guard
 *
 * Blocks edit calls on files the agent hasn't read or written in the
 * current session. Prevents broken edits from stale content assumptions.
 * Resets tracking after compaction (forces re-read).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const seenFiles = new Set<string>();

	pi.on("tool_result", async (event) => {
		if (event.isError) return;

		if (event.toolName === "read" || event.toolName === "write") {
			const path = (event.input as { path?: string })?.path;
			if (path) seenFiles.add(path);
		}
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "edit") return;

		const input = event.input as { path?: string; multi?: Array<{ path?: string }> };

		// Single edit
		if (input.path && !input.multi && !seenFiles.has(input.path)) {
			return {
				block: true,
				reason: `Read ${input.path} before editing — file content may have changed.`,
			};
		}

		// Multi-edit (batch): check all paths
		if (input.multi) {
			for (const edit of input.multi) {
				const path = edit.path || input.path;
				if (path && !seenFiles.has(path)) {
					return {
						block: true,
						reason: `Read ${path} before editing — file content may have changed.`,
					};
				}
			}
		}
	});

	pi.on("session_compact", async () => {
		seenFiles.clear();
	});
}
