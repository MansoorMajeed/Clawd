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
	checkDangerousPattern,
	isPathAllowed,
	extractPaths,
} from "./permissions.js";

interface PermissionsConfig {
	additionalDirectories?: string[];
	allowedPaths?: string[];
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

async function saveProjectConfig(configPath: string, config: PermissionsConfig): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

export default function (pi: ExtensionAPI) {
	const yoloMode = pi.getFlag("--yolo") === true;

	// State
	let allowedDirs: string[] = [];
	let allowedPaths: string[] = [];
	let projectConfigPath = "";
	let projectConfig: PermissionsConfig = {};

	// Load config on session start
	pi.on("session_start", async (_event, ctx) => {
		const cwd = ctx.cwd;
		projectConfigPath = resolve(cwd, ".pi/permissions.json");
		const globalConfigPath = resolve(process.env.HOME || "", ".pi/agent/permissions.json");

		projectConfig = await loadConfig(projectConfigPath);
		const globalConfig = await loadConfig(globalConfigPath);

		// Build allowed directories: cwd + additional dirs from project + global config
		allowedDirs = [cwd];
		for (const dir of projectConfig.additionalDirectories ?? []) {
			allowedDirs.push(await resolvePath(dir, cwd));
		}
		for (const dir of globalConfig.additionalDirectories ?? []) {
			allowedDirs.push(await resolvePath(dir, cwd));
		}

		// Build allowed paths: merge project + global
		allowedPaths = [];
		for (const p of projectConfig.allowedPaths ?? []) {
			allowedPaths.push(await resolvePath(p, cwd));
		}
		for (const p of globalConfig.allowedPaths ?? []) {
			allowedPaths.push(await resolvePath(p, cwd));
		}
	});

	// Register --yolo flag
	pi.registerFlag("yolo", {
		description: "Skip permission prompts (hard blocks still enforced)",
		type: "boolean",
		default: false,
	});

	// Register /add-dir command
	pi.registerCommand("add-dir", {
		description: "Add a directory to the allowed list",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /add-dir <path>", "error");
				return;
			}

			const resolved = await resolvePath(args.trim(), ctx.cwd);
			if (allowedDirs.includes(resolved)) {
				ctx.ui.notify(`Already allowed: ${resolved}`, "info");
				return;
			}

			allowedDirs.push(resolved);
			ctx.ui.notify(`Added to session: ${resolved}`, "success");

			const persist = await ctx.ui.confirm(
				"Persist?",
				`Also save to .pi/permissions.json for future sessions?`,
			);

			if (persist) {
				if (!projectConfig.additionalDirectories) {
					projectConfig.additionalDirectories = [];
				}
				projectConfig.additionalDirectories.push(args.trim());
				await saveProjectConfig(projectConfigPath, projectConfig);
				ctx.ui.notify("Saved to .pi/permissions.json", "success");
			}
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

		// ── File operations: check path permissions ──
		const paths = extractPaths(event.toolName, event.input as Record<string, any>);
		if (paths.length === 0) return; // Not a file operation (MCP, custom tools, etc.) — auto-allow

		for (const rawPath of paths) {
			const resolved = await resolvePath(rawPath, ctx.cwd);

			if (isPathAllowed(resolved, allowedDirs, allowedPaths)) {
				continue;
			}

			// --yolo skips file permission prompts
			if (yoloMode) continue;

			// Tier 3: Outside allowed dirs — prompt
			const choice = await ctx.ui.select(
				`Permission Required: ${event.toolName} ${rawPath}`,
				["Allow once", "Allow always", "Deny"],
			);

			if (choice === "Deny" || !choice) {
				return {
					block: true,
					reason: `Blocked: ${event.toolName} on ${rawPath} — outside allowed directories.`,
				};
			}

			if (choice === "Allow always") {
				allowedPaths.push(resolved);
				if (!projectConfig.allowedPaths) {
					projectConfig.allowedPaths = [];
				}
				projectConfig.allowedPaths.push(rawPath);
				await saveProjectConfig(projectConfigPath, projectConfig);
			}
		}
	});
}
