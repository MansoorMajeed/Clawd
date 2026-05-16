/**
 * Pure permission-checking logic for the permission guard.
 * No Pi dependencies — independently testable.
 */

// ─── Shell Parsing ───

export function splitCommands(command: string): string[] {
	const segments: string[] = [];
	let current: string[] = [];
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let i = 0;

	while (i < command.length) {
		const ch = command[i];

		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			current.push(ch);
			i++;
			continue;
		}
		if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			current.push(ch);
			i++;
			continue;
		}

		if (inSingleQuote || inDoubleQuote) {
			current.push(ch);
			i++;
			continue;
		}

		if (ch === "\n" || ch === "\r" || ch === ";" || ch === "|") {
			segments.push(current.join(""));
			current = [];
			if (ch === "|" && i + 1 < command.length && command[i + 1] === "|") {
				i++;
			}
			i++;
			continue;
		}
		if (ch === "&" && i + 1 < command.length && command[i + 1] === "&") {
			segments.push(current.join(""));
			current = [];
			i += 2;
			continue;
		}

		current.push(ch);
		i++;
	}

	if (current.length > 0) {
		segments.push(current.join(""));
	}

	return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

export function stripQuotedContent(segment: string): string {
	const result: string[] = [];
	let i = 0;

	while (i < segment.length) {
		const ch = segment[i];

		if (ch === "$" && i + 1 < segment.length && segment[i + 1] === "'") {
			i += 2;
			while (i < segment.length && segment[i] !== "'") {
				if (segment[i] === "\\" && i + 1 < segment.length) {
					i += 2;
				} else {
					i++;
				}
			}
			i++;
			continue;
		}

		if (ch === "'") {
			i++;
			while (i < segment.length && segment[i] !== "'") {
				i++;
			}
			i++;
			continue;
		}

		if (ch === '"') {
			i++;
			while (i < segment.length && segment[i] !== '"') {
				if (segment[i] === "\\" && i + 1 < segment.length) {
					i += 2;
				} else {
					i++;
				}
			}
			i++;
			continue;
		}

		result.push(ch);
		i++;
	}

	return result.join("");
}

function tokenizeShellSegment(segment: string): string[] {
	const tokens: string[] = [];
	let current: string[] = [];
	let i = 0;

	function pushToken() {
		if (current.length > 0) {
			tokens.push(current.join(""));
			current = [];
		}
	}

	while (i < segment.length) {
		const ch = segment[i];

		if (/\s/.test(ch)) {
			pushToken();
			i++;
			continue;
		}

		if (ch === "\\" && i + 1 < segment.length) {
			current.push(segment[i + 1]);
			i += 2;
			continue;
		}

		if (ch === "$" && i + 1 < segment.length && segment[i + 1] === "'") {
			i += 2;
			while (i < segment.length && segment[i] !== "'") {
				if (segment[i] === "\\" && i + 1 < segment.length) {
					current.push(segment[i + 1]);
					i += 2;
				} else {
					current.push(segment[i]);
					i++;
				}
			}
			i++;
			continue;
		}

		if (ch === "'") {
			i++;
			while (i < segment.length && segment[i] !== "'") {
				current.push(segment[i]);
				i++;
			}
			i++;
			continue;
		}

		if (ch === '"') {
			i++;
			while (i < segment.length && segment[i] !== '"') {
				if (segment[i] === "\\" && i + 1 < segment.length) {
					current.push(segment[i + 1]);
					i += 2;
				} else {
					current.push(segment[i]);
					i++;
				}
			}
			i++;
			continue;
		}

		current.push(ch);
		i++;
	}

	pushToken();
	return tokens;
}

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--super-prefix",
	"--config-env",
]);

const GIT_GLOBAL_OPTIONS_WITH_INLINE_VALUE = [
	"-C",
	"-c",
	"--git-dir=",
	"--work-tree=",
	"--namespace=",
	"--exec-path=",
	"--super-prefix=",
	"--config-env=",
];

const ENV_OPTIONS_WITH_VALUE = new Set([
	"-u",
	"--unset",
	"-C",
	"--chdir",
	"-S",
	"--split-string",
	"--block-signal",
	"--default-signal",
	"--ignore-signal",
]);

const ENV_OPTIONS_WITH_INLINE_VALUE = [
	"--unset=",
	"--chdir=",
	"--split-string=",
	"--block-signal=",
	"--default-signal=",
	"--ignore-signal=",
];

function isEnvironmentAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function skipEnvInvocation(tokens: string[], index: number): number {
	let i = index + 1;

	while (i < tokens.length) {
		const token = tokens[i];

		if (token === "--") {
			i++;
			break;
		}

		if (isEnvironmentAssignment(token)) {
			i++;
			continue;
		}

		if (ENV_OPTIONS_WITH_VALUE.has(token)) {
			i += 2;
			continue;
		}

		if (ENV_OPTIONS_WITH_INLINE_VALUE.some((option) => token.startsWith(option))) {
			i++;
			continue;
		}

		if (token === "-i" || token === "-") {
			i++;
			continue;
		}

		break;
	}

	return i;
}

function skipCommandInvocation(tokens: string[], index: number): number {
	let i = index + 1;

	while (tokens[i] === "-p") {
		i++;
	}

	if (tokens[i] === "-v" || tokens[i] === "-V") {
		return tokens.length;
	}

	return i;
}

function findGitCommandIndex(tokens: string[]): number {
	let i = 0;

	while (i < tokens.length) {
		while (isEnvironmentAssignment(tokens[i])) {
			i++;
		}

		if (tokens[i] === "env") {
			i = skipEnvInvocation(tokens, i);
			continue;
		}

		if (tokens[i] === "command") {
			i = skipCommandInvocation(tokens, i);
			continue;
		}

		break;
	}

	return tokens[i] === "git" ? i : -1;
}

function findGitSubcommandIndex(tokens: string[]): number {
	const gitCommandIndex = findGitCommandIndex(tokens);
	if (gitCommandIndex === -1) return -1;

	let i = gitCommandIndex + 1;
	while (i < tokens.length) {
		const token = tokens[i];

		if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
			i += 2;
			continue;
		}

		if (
			GIT_GLOBAL_OPTIONS_WITH_INLINE_VALUE.some(
				(option) => token.startsWith(option) && token.length > option.length,
			)
		) {
			i++;
			continue;
		}

		if (token.startsWith("--") || (token.startsWith("-") && token !== "-")) {
			i++;
			continue;
		}

		return i;
	}

	return -1;
}

function isBroadGitAddOption(token: string): boolean {
	if (token === "--all" || token === "--update") return true;
	if (!token.startsWith("-") || token === "-") return false;
	if (token.startsWith("--")) return false;

	return token.slice(1).includes("A") || token.slice(1).includes("u");
}

function isInteractiveGitAddOption(token: string): boolean {
	if (token === "--patch" || token === "--interactive") return true;
	if (!token.startsWith("-") || token === "-" || token.startsWith("--")) return false;

	return token.slice(1).includes("p") || token.slice(1).includes("i");
}

function isCurrentDirectoryPathspec(token: string): boolean {
	const normalized = token.replace(/\/+/g, "/").replace(/\/+$/, "");
	return normalized === "." || normalized === "./.";
}

function isTopPathspec(token: string): boolean {
	if (token === ":/") return true;
	if (!token.startsWith(":(")) return false;

	const closeParen = token.indexOf(")");
	if (closeParen === -1) return false;

	const magic = token.slice(2, closeParen).split(",");
	if (!magic.includes("top")) return false;

	const remainder = token.slice(closeParen + 1);
	return remainder === "" || remainder === "/" || isCurrentDirectoryPathspec(remainder);
}

function isBroadGitAddPathspec(token: string): boolean {
	return isCurrentDirectoryPathspec(token) || isTopPathspec(token);
}

export function checkBroadGitAdd(command: string): { description: string } | null {
	const segments = splitCommands(command);

	for (const segment of segments) {
		const tokens = tokenizeShellSegment(segment);
		const gitSubcommandIndex = findGitSubcommandIndex(tokens);

		if (gitSubcommandIndex === -1 || tokens[gitSubcommandIndex] !== "add") {
			continue;
		}

		const args = tokens.slice(gitSubcommandIndex + 1);
		const interactive = args.some(isInteractiveGitAddOption);
		if (interactive) {
			continue;
		}

		let pathspecMode = false;
		for (const arg of args) {
			if (arg === "--") {
				pathspecMode = true;
				continue;
			}

			if (!pathspecMode && isBroadGitAddOption(arg)) {
				return { description: "Broad git staging" };
			}

			if (pathspecMode || !arg.startsWith("-") || arg === "-") {
				if (isBroadGitAddPathspec(arg)) {
					return { description: "Broad git staging" };
				}
			}
		}
	}

	return null;
}

// ─── Hard Blocks ───

const HARD_BLOCK_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
	// .git directory deletion
	{ pattern: /\brm\s+.*-[^\s]*r.*\s+\.git\s*\/?$/, description: "Delete .git directory" },
	{ pattern: /\brm\s+.*-[^\s]*r.*\s+\.git\//, description: "Delete .git directory" },
	{ pattern: /\brm\s+-rf\s+\.git\s*\/?$/, description: "Delete .git directory" },
	{ pattern: /\bfind\s+\.git\b.*-delete\b/, description: "Delete .git directory" },
	// Nuke root
	{ pattern: /\brm\s+.*-[^\s]*r[^\s]*f\s+\/\s*$/, description: "Delete root filesystem" },
	// Nuke home
	{ pattern: /\brm\s+.*-[^\s]*r[^\s]*f\s+~\s*\/?$/, description: "Delete home directory" },
];

export function checkHardBlock(command: string): { description: string } | null {
	const segments = splitCommands(command);

	for (const segment of segments) {
		const stripped = stripQuotedContent(segment);
		for (const { pattern, description } of HARD_BLOCK_PATTERNS) {
			if (pattern.test(stripped)) {
				return { description };
			}
		}
	}

	return null;
}

// ─── Dangerous Patterns ───

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
	// File deletion
	{ pattern: /\brm\s+.*-[^\s]*r[^\s]*f/, description: "rm with -rf (recursive force delete)" },
	{ pattern: /\brm\s+.*-[^\s]*f[^\s]*r/, description: "rm with -fr (recursive force delete)" },
	{ pattern: /\brm\s+-rf\b/, description: "rm -rf" },
	{ pattern: /\brm\s+-r\b/, description: "rm -r (recursive delete)" },

	// Git destructive
	{ pattern: /\bgit\s+reset\s+--hard\b/, description: "git reset --hard (destroys uncommitted changes)" },
	{ pattern: /\bgit\s+push\s+.*--force\b/, description: "git push --force (rewrites remote history)" },
	{ pattern: /\bgit\s+push\s+.*-f\b/, description: "git push -f (rewrites remote history)" },
	{ pattern: /\bgit\s+clean\s+.*-f/, description: "git clean -f (deletes untracked files)" },
	{ pattern: /\bgit\s+checkout\s+\.\s*$/, description: "git checkout . (discards all working tree changes)" },
	{ pattern: /\bgit\s+restore\s+\.\s*$/, description: "git restore . (discards all working tree changes)" },
	{ pattern: /\bgit\s+branch\s+.*-D\b/, description: "git branch -D (force-deletes branch)" },
	{ pattern: /\bgit\s+commit\s+.*--amend\b/, description: "git commit --amend (rewrites history)" },
	{ pattern: /\bgit\s+add\s+-A\b/, description: "git add -A (stages everything)" },
	{ pattern: /\bgit\s+add\s+\.\s*$/, description: "git add . (stages everything)" },
	{ pattern: /\bgit\s+push\s+.*--no-verify\b/, description: "git push --no-verify (skips hooks)" },
	{ pattern: /\bgit\s+commit\s+.*--no-verify\b/, description: "git commit --no-verify (skips hooks)" },
	{ pattern: /\bgit\s+rebase\s+.*-i\b/, description: "git rebase -i (interactive rebase, rewrites history)" },

	// Disk / device writes
	{ pattern: /\bdd\s+.*if=/, description: "dd (raw disk write)" },
	{ pattern: /\bmkfs\b/, description: "mkfs (format filesystem)" },
	{ pattern: /\bfdisk\b/, description: "fdisk (partition table editor)" },
	{ pattern: /\bparted\b/, description: "parted (partition editor)" },

	// Permission changes on system paths
	{ pattern: /\bchmod\s+.*-R\s+777\b/, description: "chmod -R 777 (world-writable recursive)" },
	{
		pattern: /\bchown\s+.*-R\s+.*\s+\/(etc|usr|bin|sbin|lib|var)\b/,
		description: "chown -R on system path",
	},

	// Privilege escalation
	{ pattern: /\bsudo\s+/, description: "sudo (privilege escalation)" },

	// Remote code execution (checked against full command, not segments — see PIPE_PATTERNS)


	// Accidental publishes
	{ pattern: /\bnpm\s+publish\b/, description: "npm publish (publishes package)" },
	{ pattern: /\bcargo\s+publish\b/, description: "cargo publish (publishes crate)" },

	// Container / k8s destruction
	{ pattern: /\bkubectl\s+delete\b/, description: "kubectl delete (destroys resources)" },
	{ pattern: /\bdocker\s+rm\b/, description: "docker rm (removes containers)" },
	{ pattern: /\bdocker\s+system\s+prune\b/, description: "docker system prune (removes all unused data)" },
];

// Patterns that span pipe boundaries — checked against the full command
const PIPE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
	{ pattern: /\bcurl\s+.*\|\s*(bash|sh|zsh)\b/, description: "curl piped to shell (remote code execution)" },
	{ pattern: /\bwget\s+.*\|\s*(bash|sh|zsh)\b/, description: "wget piped to shell (remote code execution)" },
];

export function checkDangerousPattern(command: string): { description: string } | null {
	// Check pipe-spanning patterns on the full command (stripped of quotes but not split)
	const fullStripped = stripQuotedContent(command);
	for (const { pattern, description } of PIPE_PATTERNS) {
		if (pattern.test(fullStripped)) {
			return { description };
		}
	}

	// Check per-segment patterns
	const segments = splitCommands(command);

	for (const segment of segments) {
		const stripped = stripQuotedContent(segment);
		for (const { pattern, description } of DANGEROUS_PATTERNS) {
			if (pattern.test(stripped)) {
				return { description };
			}
		}
	}

	return null;
}

// ─── Path Checking ───

function normalizePath(p: string): string {
	// Remove trailing slashes (but keep root "/")
	let normalized = p.replace(/\/+$/, "") || "/";
	return normalized;
}

export function isPathAllowed(
	filePath: string,
	allowed: string[],
): boolean {
	const normalized = normalizePath(filePath);

	for (const entry of allowed) {
		const normalizedEntry = normalizePath(entry);
		if (normalized === normalizedEntry || normalized.startsWith(normalizedEntry + "/")) {
			return true;
		}
	}

	return false;
}

export type AccessMode = "read" | "write";

export function checkAccess(
	filePath: string,
	mode: AccessMode,
	readPaths: string[],
	readWritePaths: string[],
): boolean {
	if (mode === "read") {
		return isPathAllowed(filePath, [...readPaths, ...readWritePaths]);
	}

	return isPathAllowed(filePath, readWritePaths);
}

export function toolMode(toolName: string): AccessMode | null {
	if (toolName === "read") return "read";
	if (toolName === "write" || toolName === "edit") return "write";
	return null;
}

// ─── Path Extraction ───

export function extractPaths(toolName: string, input: Record<string, any>): string[] {
	const paths: Set<string> = new Set();

	if (toolName === "read" || toolName === "write") {
		if (input.path) paths.add(input.path);
	} else if (toolName === "edit") {
		// Single edit
		if (input.path) paths.add(input.path);

		// Multi edit
		if (Array.isArray(input.multi)) {
			for (const edit of input.multi) {
				if (edit.path) paths.add(edit.path);
			}
		}

		// Patch mode — parse *** <path> lines
		if (typeof input.patch === "string") {
			const patchLines = input.patch.split("\n");
			for (const line of patchLines) {
				const match = line.match(/^\*\*\*\s+(.+)$/);
				if (match && !match[1].startsWith("Begin") && !match[1].startsWith("End")) {
					paths.add(match[1].trim());
				}
			}
		}
	}

	return [...paths];
}
