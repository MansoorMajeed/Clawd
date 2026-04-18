/**
 * Dangerous Command Guard - Intercepts dangerous bash commands
 *
 * Converted from Claude Code PreToolUse hook. Detects destructive commands
 * (rm -rf, git reset --hard, etc.) and requires user confirmation.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
	// File deletion
	{ pattern: /\brm\s+.*-[^\s]*r[^\s]*f/, description: "rm with -rf (recursive force delete)" },
	{ pattern: /\brm\s+.*-[^\s]*f[^\s]*r/, description: "rm with -fr (recursive force delete)" },
	{ pattern: /\brm\s+-rf\b/, description: "rm -rf" },
	{ pattern: /\brm\s+-r\b/, description: "rm -r (recursive delete)" },
	{ pattern: /\brm\s+(?!.*\.)((\/)|(\s+~\/?(\s|$)))/, description: "rm on root or home directory" },

	// Git destructive
	{ pattern: /\bgit\s+reset\s+--hard\b/, description: "git reset --hard (destroys uncommitted changes)" },
	{ pattern: /\bgit\s+push\s+.*--force\b/, description: "git push --force (rewrites remote history)" },
	{ pattern: /\bgit\s+push\s+.*-f\b/, description: "git push -f (rewrites remote history)" },
	{ pattern: /\bgit\s+clean\s+.*-f/, description: "git clean -f (deletes untracked files)" },
	{ pattern: /\bgit\s+checkout\s+\.\s*$/, description: "git checkout . (discards all working tree changes)" },
	{ pattern: /\bgit\s+restore\s+\.\s*$/, description: "git restore . (discards all working tree changes)" },
	{ pattern: /\bgit\s+branch\s+.*-D\b/, description: "git branch -D (force-deletes branch)" },

	// Disk / device writes
	{ pattern: /\bdd\s+.*if=/, description: "dd (raw disk write)" },
	{ pattern: /\bmkfs\b/, description: "mkfs (format filesystem)" },
	{ pattern: /\bfdisk\b/, description: "fdisk (partition table editor)" },
	{ pattern: /\bparted\b/, description: "parted (partition editor)" },

	// Git footguns (not destructive, but common mistakes)
	{ pattern: /\bgit\s+add\s+(-A|--all|\.\s*$)/, description: "git add -A/. (may stage secrets, .env, or binaries — stage specific files instead)" },
	{ pattern: /\bgit\s+commit\s+.*--amend\b/, description: "git commit --amend (modifies previous commit — prefer creating a new commit)" },
	{ pattern: /\bgit\s+(rebase|add)\s+.*-i\b/, description: "interactive git flag (-i requires terminal interaction, won't work here)" },
	{ pattern: /\bgit\s+push\s+.*--no-verify\b/, description: "git push --no-verify (skipping hooks — investigate the hook failure instead)" },
	{ pattern: /\bgit\s+commit\s+.*--no-verify\b/, description: "git commit --no-verify (skipping hooks — investigate the hook failure instead)" },

	// Permission changes on system paths
	{ pattern: /\bchmod\s+.*-R\s+777\b/, description: "chmod -R 777 (world-writable recursive)" },
	{
		pattern: /\bchown\s+.*-R\s+.*\s+\/(etc|usr|bin|sbin|lib|var)\b/,
		description: "chown -R on system path",
	},
];

/**
 * Split composite shell command into segments, respecting quotes.
 */
function splitCommands(command: string): string[] {
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

		if (ch === ";" || ch === "|") {
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

/**
 * Strip quoted content so patterns in string literals don't trigger.
 */
function stripQuotedContent(segment: string): string {
	const result: string[] = [];
	let i = 0;

	while (i < segment.length) {
		const ch = segment[i];

		// ANSI-C quoting $'...'
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

		// Single-quoted string
		if (ch === "'") {
			i++;
			while (i < segment.length && segment[i] !== "'") {
				i++;
			}
			i++;
			continue;
		}

		// Double-quoted string
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

/**
 * Check command for dangerous patterns.
 */
function checkCommand(command: string): { matched: true; description: string } | null {
	const segments = splitCommands(command);

	for (const segment of segments) {
		const stripped = stripQuotedContent(segment);
		for (const { pattern, description } of DANGEROUS_PATTERNS) {
			if (pattern.test(stripped)) {
				return { matched: true, description };
			}
		}
	}

	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		// Only intercept bash tool
		if (event.toolName !== "bash") {
			return;
		}

		const command = (event.input as { command?: string })?.command;
		if (!command) {
			return;
		}

		const result = checkCommand(command);
		if (!result) {
			return;
		}

		// Require user confirmation for dangerous commands
		const confirmed = await ctx.ui.confirm(
			"Dangerous Command Detected",
			`${result.description}\n\nCommand: ${command}\n\nIf this is an irreversible action, load and follow the irreversible-action-checklist skill before retrying.`
		);

		if (confirmed) {
			return;
		}

		return {
			block: true,
			reason: `Command blocked: ${result.description}. Before retrying: load and follow the irreversible-action-checklist skill. Do not retry without completing the checklist.`,
		};
	});
}
