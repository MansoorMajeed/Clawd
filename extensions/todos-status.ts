/**
 * Todos Status
 *
 * Shows `todos <open>/<total>` on the extension status row. Hidden when
 * the todo directory is empty or absent. Matches the directory and
 * closed-status semantics used by extensions/todos.ts.
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
			const text = readFileSync(path.join(dir, name), "utf8");
			const match = text.match(/^status:\s*"?([A-Za-z_-]+)"?/m);
			if (match) status = match[1].toLowerCase();
		} catch {
			// keep default
		}
		if (!CLOSED_STATUSES.has(status)) open++;
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
	pi.on("agent_end", (_event, ctx) => render(ctx));
	pi.on("session_compact", (_event, ctx) => render(ctx));
	pi.on("session_switch", (_event, ctx) => render(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
