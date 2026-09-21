/**
 * Read-Before-Edit Guard
 *
 * Blocks edit calls on files the agent hasn't read or written in the
 * current session. Prevents broken edits from stale content assumptions.
 * Resets tracking after compaction (forces re-read).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveToolPath } from "./permission-guard/permissions.js";

type EditInput = {
	path?: string;
	edits?: Array<{ oldText: string; newText: string }>;
};

export function recordSeenFile(
	seenFiles: ReadonlySet<string>,
	cwd: string,
	filePath: string,
): Set<string> {
	return new Set(seenFiles).add(resolveToolPath(filePath, cwd));
}

export function findUnreadEditPath(
	seenFiles: ReadonlySet<string>,
	cwd: string,
	input: EditInput,
): string | undefined {
	if (!input.path) return undefined;
	return seenFiles.has(resolveToolPath(input.path, cwd)) ? undefined : input.path;
}

export function resetSeenFiles(_seenFiles: ReadonlySet<string>): Set<string> {
	return new Set();
}

export default function (pi: ExtensionAPI) {
	let seenFiles = new Set<string>();

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		if (event.toolName === "read" || event.toolName === "write") {
			const filePath = (event.input as { path?: string })?.path;
			if (filePath) seenFiles = recordSeenFile(seenFiles, ctx.cwd, filePath);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit") return;

		const unreadPath = findUnreadEditPath(seenFiles, ctx.cwd, event.input as EditInput);
		if (unreadPath) {
			return {
				block: true,
				reason: `Read ${unreadPath} before editing — file content may have changed.`,
			};
		}
	});

	pi.on("session_compact", async () => {
		seenFiles = resetSeenFiles(seenFiles);
	});
}
