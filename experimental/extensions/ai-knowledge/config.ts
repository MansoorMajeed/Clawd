import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { validateConfig } from "./config-pure.js";
import type { Config } from "./types.js";

const CONFIG_FILENAME = "ai-knowledge.json";

export type LoadResult =
	| { kind: "ok"; config: Config }
	| { kind: "missing" }
	| { kind: "error"; message: string };

function expandTilde(p: string): string {
	if (p === "~") return process.env.HOME || "";
	if (p.startsWith("~/")) return resolve(process.env.HOME || "", p.slice(2));
	return p;
}

function configPath(): string {
	const home = process.env.HOME || "";
	return join(home, ".pi", "agent", CONFIG_FILENAME);
}

export async function loadConfig(): Promise<LoadResult> {
	const path = configPath();
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "missing" };
		}
		return { kind: "error", message: `Cannot read ${path}: ${(e as Error).message}` };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { kind: "error", message: `Invalid JSON in ${path}: ${(e as Error).message}` };
	}

	const validated = validateConfig(raw);
	if (!validated) {
		return {
			kind: "error",
			message: `${path} is missing a non-empty string "rootPath"`,
		};
	}

	const expanded = expandTilde(validated.rootPath);
	try {
		const s = await stat(expanded);
		if (!s.isDirectory()) {
			return { kind: "error", message: `rootPath "${expanded}" is not a directory` };
		}
	} catch {
		return { kind: "error", message: `rootPath "${expanded}" does not exist` };
	}

	return { kind: "ok", config: { rootPath: expanded, autoCommit: validated.autoCommit } };
}

export function getConfigPath(): string {
	return configPath();
}
