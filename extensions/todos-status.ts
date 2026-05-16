/**
 * Todos Status
 *
 * Shows `todos <open>/<total>` on the extension status row. Hidden when
 * the todo directory is empty or absent. Matches the directory and
 * closed-status semantics used by extensions/todos.ts.
 *
 * Todo files written by extensions/todos.ts start with a JSON object
 * (front matter), optionally followed by markdown body. Keep this parser
 * in sync with that format.
 */

import { readdirSync, readFileSync } from "fs";
import path from "path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "todos-status";
const TODO_DIR_NAME = ".pi/todos";
const TODO_PATH_ENV = "PI_TODO_PATH";
const CLOSED_STATUSES = new Set(["closed", "done"]);

function resolveTodosDir(cwd: string): string {
	const override = process.env[TODO_PATH_ENV];
	if (override && override.trim()) return path.resolve(cwd, override.trim());
	return path.resolve(cwd, TODO_DIR_NAME);
}

// Find the end index of the leading JSON object in a todo file. Returns -1
// if the file doesn't start with `{` or the object is unterminated. Mirrors
// the implementation in extensions/todos.ts.
function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < content.length; i += 1) {
		const char = content[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === "\"") inString = false;
			continue;
		}

		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth += 1;
			continue;
		}
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Parses the leading JSON front-matter of a todo file and returns its
 * lowercased status, defaulting to "open" when the file is empty,
 * malformed, or missing the status field.
 */
export function parseTodoStatus(content: string): string {
	if (!content.startsWith("{")) return "open";
	const end = findJsonObjectEnd(content);
	if (end === -1) return "open";
	try {
		const parsed = JSON.parse(content.slice(0, end + 1)) as { status?: unknown };
		if (parsed && typeof parsed.status === "string" && parsed.status.trim()) {
			return parsed.status.toLowerCase();
		}
	} catch {
		// fall through
	}
	return "open";
}

export function isTodoClosed(status: string): boolean {
	return CLOSED_STATUSES.has(status);
}

function countTodos(cwd: string): { open: number; total: number } {
	const dir = resolveTodosDir(cwd);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return { open: 0, total: 0 };
	}

	let open = 0;
	let total = 0;
	for (const name of entries) {
		if (!name.endsWith(".md")) continue;
		total++;
		let status = "open";
		try {
			status = parseTodoStatus(readFileSync(path.join(dir, name), "utf8"));
		} catch {
			// keep default
		}
		if (!isTodoClosed(status)) open++;
	}
	return { open, total };
}

function render(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const { open, total } = countTodos(ctx.cwd);
	if (total === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const theme = ctx.ui.theme;
	const text = `todos ${open}/${total}`;
	ctx.ui.setStatus(STATUS_KEY, open === 0 ? theme.fg("muted", text) : text);
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
