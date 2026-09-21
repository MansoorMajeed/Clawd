import type { Config } from "./types.js";

/**
 * Pure: validate a raw settings object and produce a typed Config.
 * No filesystem access, no `~` expansion. Caller does that on top.
 * Returns null if input cannot produce a valid Config.
 */
export function validateConfig(raw: unknown): Config | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) return null;

	const obj = raw as Record<string, unknown>;
	const rootPath = obj.rootPath;
	if (typeof rootPath !== "string" || rootPath.length === 0) return null;

	const autoCommit = typeof obj.autoCommit === "boolean" ? obj.autoCommit : true;

	return { rootPath, autoCommit };
}
