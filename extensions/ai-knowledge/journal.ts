import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	foldAppend,
	formatSessions,
	pickRecentSessions,
	type NowStamp,
} from "./journal-content.js";
import { sessionPath, sessionsDir } from "./paths.js";
import type { CurrentTask } from "./types.js";

export function timestampForFilename(d: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function nowStamp(d: Date = new Date()): NowStamp {
	const pad = (n: number) => String(n).padStart(2, "0");
	return {
		date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
		hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
	};
}

export async function appendEntry(
	root: string,
	current: CurrentTask,
	text: string,
	now: NowStamp = nowStamp(),
): Promise<string> {
	const dir = sessionsDir(root, current.project, current.task);
	await mkdir(dir, { recursive: true });

	const file = sessionPath(root, current.project, current.task, current.sessionFile);
	let existing = "";
	try {
		existing = await readFile(file, "utf8");
	} catch {
		existing = "";
	}

	const updated = foldAppend(existing, text, now, current.task);
	await writeFile(file, updated, "utf8");
	return file;
}

/**
 * Read up to `n` most-recent session files for a task, formatted into a single
 * string. Returns the formatted content. Missing sessions dir or empty dir
 * returns the "(no journal entries yet)" placeholder via formatSessions.
 */
export async function readRecentSessions(
	root: string,
	current: CurrentTask,
	n: number,
): Promise<string> {
	const dir = sessionsDir(root, current.project, current.task);
	let entries: string[] = [];
	try {
		entries = await readdir(dir);
	} catch {
		return formatSessions([]);
	}
	const picked = pickRecentSessions(entries, n);
	const sessions = await Promise.all(
		picked.map(async (name) => ({
			name,
			content: await readFile(join(dir, name), "utf8").catch(() => ""),
		})),
	);
	return formatSessions(sessions.filter((s) => s.content.length > 0));
}
