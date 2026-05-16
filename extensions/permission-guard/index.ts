/**
 * Permission Guard — Default-deny permission system for Pi.
 *
 * Intercepts all tool calls. Auto-allows operations within the project
 * directory. Prompts for anything outside. Hard-blocks truly destructive
 * commands (no override). Replaces dangerous-command-guard.ts.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { realpath } from "node:fs/promises";
import {
	checkHardBlock,
	checkBroadGitAdd,
	checkDangerousPattern,
	checkAccess,
	extractPaths,
	toolMode,
	type AccessMode,
} from "./permissions.js";

interface PermissionsConfig {
	readPaths?: string[];
	readWritePaths?: string[];
	additionalDirectories?: string[];
	allowedPaths?: string[];
}

interface NormalizedPermissionsConfig {
	readPaths: string[];
	readWritePaths: string[];
}

interface PermissionGuardContext {
	cwd: string;
	ui: {
		select(title: string, choices: string[]): Promise<string | null | undefined>;
		notify(message: string, type?: string): void;
	};
}

export function normalizePermissionConfig(config: PermissionsConfig): NormalizedPermissionsConfig {
	return {
		readPaths: [...(config.readPaths ?? [])],
		readWritePaths: [
			...(config.readWritePaths ?? []),
			...(config.additionalDirectories ?? []),
			...(config.allowedPaths ?? []),
		],
	};
}

async function loadConfig(path: string): Promise<PermissionsConfig> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return {};
	}
	return JSON.parse(raw);
}

function expandTilde(p: string): string {
	if (p === "~") {
		return process.env.HOME || "";
	}
	if (p.startsWith("~/")) {
		return resolve(process.env.HOME || "", p.slice(2));
	}
	return p;
}

async function resolvePath(p: string, cwd: string): Promise<string> {
	const expanded = expandTilde(p);
	const absolute = resolve(cwd, expanded);
	try {
		return await realpath(absolute);
	} catch {
		return absolute;
	}
}

export async function pathForPersistence(
	scope: "project" | "global",
	rawPath: string,
	cwd: string,
): Promise<string> {
	return scope === "global" ? await resolvePath(rawPath, cwd) : rawPath;
}

export function readOnlyCoverage(
	resolved: string,
	readPaths: string[],
	readWritePaths: string[],
): "read-write" | "read" | null {
	if (checkAccess(resolved, "write", [], readWritePaths)) {
		return "read-write";
	}
	if (checkAccess(resolved, "read", readPaths, [])) {
		return "read";
	}
	return null;
}

async function saveConfig(configPath: string, config: PermissionsConfig): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

async function saveProjectConfig(configPath: string, config: PermissionsConfig): Promise<void> {
	await saveConfig(configPath, config);
}

async function saveGlobalConfig(configPath: string, config: PermissionsConfig): Promise<void> {
	await saveConfig(configPath, config);
}

async function containsResolvedPath(paths: string[], rawPath: string, cwd: string): Promise<boolean> {
	const resolved = await resolvePath(rawPath, cwd);
	for (const path of paths) {
		if ((await resolvePath(path, cwd)) === resolved) {
			return true;
		}
	}
	return false;
}

async function removeResolvedPath(paths: string[], rawPath: string, cwd: string): Promise<string[]> {
	const resolved = await resolvePath(rawPath, cwd);
	const kept: string[] = [];
	for (const path of paths) {
		if ((await resolvePath(path, cwd)) !== resolved) {
			kept.push(path);
		}
	}
	return kept;
}

export default function (pi: ExtensionAPI) {
	const yoloMode = pi.getFlag("--yolo") === true;

	let readPaths: string[] = [];
	let readWritePaths: string[] = [];
	let projectConfigPath = "";
	let globalConfigPath = "";
	let projectConfig: PermissionsConfig = {};
	let globalConfig: PermissionsConfig = {};

	function addSessionPath(mode: AccessMode, resolved: string) {
		if (mode === "write") {
			readPaths = readPaths.filter((path) => path !== resolved);
			if (!readWritePaths.includes(resolved)) {
				readWritePaths.push(resolved);
			}
			return;
		}

		if (!readWritePaths.includes(resolved) && !readPaths.includes(resolved)) {
			readPaths.push(resolved);
		}
	}

	async function persistEntry(scope: "project" | "global", mode: AccessMode, rawPath: string, cwd: string) {
		const config = scope === "project" ? projectConfig : globalConfig;
		const configPath = scope === "project" ? projectConfigPath : globalConfigPath;
		const persistedPath = await pathForPersistence(scope, rawPath, cwd);

		if (mode === "write") {
			config.readPaths = await removeResolvedPath(config.readPaths ?? [], rawPath, cwd);
			if (!(await containsResolvedPath(config.readWritePaths ?? [], rawPath, cwd))) {
				config.readWritePaths = [...(config.readWritePaths ?? []), persistedPath];
			}
		} else if (!(await containsResolvedPath(config.readWritePaths ?? [], rawPath, cwd))) {
			if (!(await containsResolvedPath(config.readPaths ?? [], rawPath, cwd))) {
				config.readPaths = [...(config.readPaths ?? []), persistedPath];
			}
		}

		if (scope === "project") {
			await saveProjectConfig(configPath, config);
		} else {
			await saveGlobalConfig(configPath, config);
		}
	}

	async function loadConfigPaths(config: PermissionsConfig, cwd: string) {
		const normalized = normalizePermissionConfig(config);
		for (const path of normalized.readPaths) {
			readPaths.push(await resolvePath(path, cwd));
		}
		for (const path of normalized.readWritePaths) {
			readWritePaths.push(await resolvePath(path, cwd));
		}
	}

	async function promptPersist(
		ctx: PermissionGuardContext,
		mode: AccessMode,
		rawPath: string,
	) {
		const choice = await ctx.ui.select("Persist?", ["Project", "Global", "Session only"]);
		if (choice === "Project") {
			await persistEntry("project", mode, rawPath, ctx.cwd);
			ctx.ui.notify("Saved to .pi/permissions.json", "success");
		} else if (choice === "Global") {
			await persistEntry("global", mode, rawPath, ctx.cwd);
			ctx.ui.notify("Saved to global permissions", "success");
		}
	}

	// Load config on session start
	pi.on("session_start", async (_event, ctx) => {
		const cwd = ctx.cwd;
		projectConfigPath = resolve(cwd, ".pi/permissions.json");
		globalConfigPath = resolve(process.env.HOME || "", ".pi/agent/permissions.json");

		projectConfig = await loadConfig(projectConfigPath);
		globalConfig = await loadConfig(globalConfigPath);

		readPaths = [];
		readWritePaths = [cwd];
		await loadConfigPaths(projectConfig, cwd);
		await loadConfigPaths(globalConfig, cwd);
	});

	// Register --yolo flag
	pi.registerFlag("yolo", {
		description: "Skip permission prompts (hard blocks still enforced)",
		type: "boolean",
		default: false,
	});

	// Register /add-dir command
	pi.registerCommand("add-dir", {
		description: "Add a directory to the read-write allowed list",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /add-dir <path>", "error");
				return;
			}

			const rawPath = args.trim();
			const resolved = await resolvePath(rawPath, ctx.cwd);
			if (readWritePaths.includes(resolved)) {
				ctx.ui.notify(`Already allowed read+write: ${resolved}`, "info");
				return;
			}

			addSessionPath("write", resolved);
			ctx.ui.notify(`Added to session: ${resolved}`, "success");
			await promptPersist(ctx, "write", rawPath);
		},
	});

	pi.registerCommand("add-dir-read", {
		description: "Add a directory to the read-only allowed list",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /add-dir-read <path>", "error");
				return;
			}

			const rawPath = args.trim();
			const resolved = await resolvePath(rawPath, ctx.cwd);
			const coverage = readOnlyCoverage(resolved, readPaths, readWritePaths);
			if (coverage === "read-write") {
				ctx.ui.notify(`Already allowed read+write: ${resolved}`, "info");
				return;
			}
			if (coverage === "read") {
				ctx.ui.notify(`Already allowed read-only: ${resolved}`, "info");
				return;
			}

			addSessionPath("read", resolved);
			ctx.ui.notify(`Added to session: ${resolved}`, "success");
			await promptPersist(ctx, "read", rawPath);
		},
	});

	// Main permission gate
	pi.on("tool_call", async (event, ctx) => {
		// ── Bash commands: check hard blocks and dangerous patterns ──
		if (event.toolName === "bash") {
			const command = (event.input as { command?: string })?.command;
			if (!command) return;

			// Tier 1: Hard blocks — never allowed, not even with --yolo
			const hardBlock = checkHardBlock(command);
			if (hardBlock) {
				return {
					block: true,
					reason: `HARD BLOCKED: ${hardBlock.description}. This action is never allowed.`,
				};
			}

			const broadGitAdd = checkBroadGitAdd(command);
			if (broadGitAdd) {
				return {
					block: true,
					reason:
						`Blocked: ${broadGitAdd.description}. Do not use broad staging commands like ` +
						"`git add -A`, `git add --all`, `git add .`, or `git add -u`. " +
						"Run `git status --short`, inspect the changed files, then stage only intended files with `git add <file>...`.",
				};
			}

			// Tier 3: Dangerous patterns — prompt unless --yolo
			if (!yoloMode) {
				const dangerous = checkDangerousPattern(command);
				if (dangerous) {
					const choice = await ctx.ui.select(
						`Dangerous Command: ${dangerous.description}\nCommand: ${command}`,
						["Allow", "Deny"],
					);

					if (choice !== "Allow") {
						return {
							block: true,
							reason: `Blocked: ${dangerous.description}. Consider using the irreversible-action-checklist skill before retrying.`,
						};
					}
				}
			}

			return;
		}

		const mode = toolMode(event.toolName);
		if (!mode) return;

		// ── File operations: check path permissions ──
		const paths = extractPaths(event.toolName, event.input as Record<string, any>);
		if (paths.length === 0) return;

		for (const rawPath of paths) {
			const resolved = await resolvePath(rawPath, ctx.cwd);

			if (checkAccess(resolved, mode, readPaths, readWritePaths)) {
				continue;
			}

			// --yolo skips file permission prompts
			if (yoloMode) continue;

			const choices =
				mode === "read"
					? [
							"Allow once",
							"Allow always — read (project)",
							"Allow always — read+write (project)",
							"Allow always — read (global)",
							"Allow always — read+write (global)",
							"Deny",
						]
					: [
							"Allow once",
							"Allow always — read+write (project)",
							"Allow always — read+write (global)",
							"Deny",
						];

			const choice = await ctx.ui.select(`Permission Required: ${event.toolName} ${rawPath}`, choices);

			if (choice === "Deny" || !choice) {
				return {
					block: true,
					reason: `Blocked: ${event.toolName} on ${rawPath} — outside allowed paths.`,
				};
			}

			if (choice === "Allow once") {
				continue;
			}

			const persistMode = choice.includes("read+write") ? "write" : "read";
			const scope = choice.includes("global") ? "global" : "project";
			addSessionPath(persistMode, resolved);
			await persistEntry(scope, persistMode, rawPath, ctx.cwd);
		}
	});
}
