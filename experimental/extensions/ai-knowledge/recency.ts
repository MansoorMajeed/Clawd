import { readdir } from "node:fs/promises";
import { sessionsDir } from "./paths.js";
import type { Registry } from "./types.js";

export async function loadRecency(
	root: string,
	reg: Registry,
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const project of reg.projects) {
		for (const task of project.tasks) {
			let entries: string[];
			try {
				entries = await readdir(sessionsDir(root, project.slug, task.slug));
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw e;
			}

			const newest = entries
				.filter((entry) => entry.endsWith(".md"))
				.sort((a, b) => b.localeCompare(a))[0];
			if (newest) {
				out.set(`${project.slug}/${task.slug}`, newest.slice(0, -".md".length));
			}
		}
	}
	return out;
}
