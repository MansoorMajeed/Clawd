/**
 * Permission Guard — Default-deny permission system for Pi.
 *
 * Intercepts all tool calls. Auto-allows operations within the project
 * directory. Prompts for anything outside. Hard-blocks truly destructive
 * commands (no override). Replaces dangerous-command-guard.ts.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
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
		input?(title: string, placeholder?: string): Promise<string | undefined>;
		notify(message: string, type?: string): void;
		custom?<T>(
			factory: (tui: { requestRender(): void }, theme: any, keybindings: any, done: (result: T) => void) => Component,
		): Promise<T>;
	};
}

export interface PermissionScopeOption {
	kind: "repo" | "directory" | "exact";
	label: string;
	rawPath: string;
	resolvedPath: string;
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

function isAncestorOrSame(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function isDangerouslyBroadPath(path: string): boolean {
	const root = parse(path).root;
	if (path === root) return true;
	const home = process.env.HOME;
	return !!home && path === resolve(home);
}

async function nearestExistingDir(rawPath: string, cwd: string): Promise<string> {
	let current = resolve(cwd, expandTilde(rawPath));
	while (true) {
		try {
			const info = await stat(current);
			return info.isDirectory() ? current : dirname(current);
		} catch {
			const parent = dirname(current);
			if (parent === current) return current;
			current = parent;
		}
	}
}

async function findGitRoot(startDir: string): Promise<string | null> {
	let current = startDir;
	while (true) {
		try {
			await stat(resolve(current, ".git"));
			return current;
		} catch {
			const parent = dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}
}

export async function buildPermissionScopeOptions(
	rawPath: string,
	cwd: string,
	_mode: AccessMode,
): Promise<PermissionScopeOption[]> {
	const resolvedPath = await resolvePath(rawPath, cwd);
	let isDirectory = false;
	try {
		isDirectory = (await stat(resolvedPath)).isDirectory();
	} catch {
		isDirectory = false;
	}

	const directory = isDirectory ? resolvedPath : dirname(resolvedPath);
	const existingDir = await nearestExistingDir(rawPath, cwd);
	const gitRoot = await findGitRoot(existingDir);
	const options: PermissionScopeOption[] = [];
	const seen = new Set<string>();

	async function add(kind: PermissionScopeOption["kind"], labelPrefix: string, rawCandidate: string) {
		const resolvedCandidate = await resolvePath(rawCandidate, cwd);
		if (isDangerouslyBroadPath(resolvedCandidate) || seen.has(resolvedCandidate)) return;
		seen.add(resolvedCandidate);
		options.push({
			kind,
			label: `${labelPrefix}: ${resolvedCandidate}`,
			rawPath: rawCandidate,
			resolvedPath: resolvedCandidate,
		});
	}

	if (gitRoot && isAncestorOrSame(gitRoot, resolvedPath)) {
		await add("repo", "Repo root", gitRoot);
	}
	await add("directory", "Directory", directory);
	await add("exact", isDirectory ? "Exact path" : "File only", rawPath);

	return options;
}

type ScopePromptResult =
	| { action: "grant"; option: PermissionScopeOption }
	| { action: "once" }
	| { action: "custom" }
	| { action: "deny" };

async function promptPermissionScope(
	ctx: PermissionGuardContext,
	mode: AccessMode,
	toolName: string,
	rawPath: string,
	options: PermissionScopeOption[],
): Promise<ScopePromptResult | null> {
	const items: Array<{ label: string; result: ScopePromptResult }> = [
		...options.map((option) => ({
			label: option.label,
			result: { action: "grant", option } as ScopePromptResult,
		})),
		{ label: "Allow once", result: { action: "once" } },
		{ label: "Custom path...", result: { action: "custom" } },
		{ label: "Deny", result: { action: "deny" } },
	];
	const title = `${mode === "read" ? "Read" : "Read-write"} permission required: ${toolName} ${rawPath}`;

	if (!ctx.ui.custom) {
		const choice = await ctx.ui.select(title, items.map((item) => item.label));
		return items.find((item) => item.label === choice)?.result ?? null;
	}

	return ctx.ui.custom<ScopePromptResult | null>((tui, theme, _keybindings, done) => {
		class ScopeSelector implements Component {
			private selected = 0;

			handleInput(data: string) {
				const digit = data.match(/^[1-9]$/);
				if (digit) {
					const index = Number(digit[0]) - 1;
					const item = items[index];
					if (item) done(item.result);
					return;
				}

				if (matchesKey(data, Key.up) || data === "k") {
					this.selected = Math.max(0, this.selected - 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down) || data === "j") {
					this.selected = Math.min(items.length - 1, this.selected + 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter) || data === "\n") {
					done(items[this.selected]?.result ?? null);
					return;
				}
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done(null);
				}
			}

			render(width: number): string[] {
				const lines = [
					theme.fg("accent", theme.bold(title)),
					"",
				];
				for (let i = 0; i < items.length; i++) {
					const prefix = i === this.selected ? "→ " : "  ";
					const line = `${prefix}${i + 1}. ${items[i]!.label}`;
					const rendered = truncateToWidth(line, width);
					lines.push(i === this.selected ? theme.fg("accent", rendered) : rendered);
				}
				lines.push("", theme.fg("dim", "1-9 select • ↑↓/j/k navigate • enter select • esc cancel"));
				return lines;
			}

			invalidate() {}
		}

		return new ScopeSelector();
	});
}

async function promptSelectedPermissionPath(
	ctx: PermissionGuardContext,
	mode: AccessMode,
	toolName: string,
	rawPath: string,
): Promise<{ rawPath: string; resolvedPath: string; once: boolean } | null> {
	const options = await buildPermissionScopeOptions(rawPath, ctx.cwd, mode);
	const choice = await promptPermissionScope(ctx, mode, toolName, rawPath, options);
	if (!choice || choice.action === "deny") return null;
	if (choice.action === "once") return { rawPath, resolvedPath: await resolvePath(rawPath, ctx.cwd), once: true };
	if (choice.action === "grant") {
		return { rawPath: choice.option.rawPath, resolvedPath: choice.option.resolvedPath, once: false };
	}

	if (!ctx.ui.input) return null;
	const customPath = (await ctx.ui.input("Custom permission path", rawPath))?.trim();
	if (!customPath) return null;
	const resolvedCustomPath = await resolvePath(customPath, ctx.cwd);
	if (isDangerouslyBroadPath(resolvedCustomPath)) {
		ctx.ui.notify(`Refusing dangerously broad permission path: ${resolvedCustomPath}`, "error");
		return null;
	}
	return { rawPath: customPath, resolvedPath: resolvedCustomPath, once: false };
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

			const selected = await promptSelectedPermissionPath(ctx, mode, event.toolName, rawPath);

			if (!selected) {
				return {
					block: true,
					reason: `Blocked: ${event.toolName} on ${rawPath} — outside allowed paths.`,
				};
			}

			if (selected.once) {
				continue;
			}

			addSessionPath(mode, selected.resolvedPath);
			await promptPersist(ctx, mode, selected.rawPath);
		}
	});
}
