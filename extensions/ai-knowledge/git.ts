import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const isRepoCache: Map<string, boolean> = new Map();

async function isGitRepo(pi: ExtensionAPI, root: string): Promise<boolean> {
	const cached = isRepoCache.get(root);
	if (cached !== undefined) return cached;
	const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: root,
		timeout: 3000,
	});
	const inside = result.code === 0 && result.stdout.trim() === "true";
	isRepoCache.set(root, inside);
	return inside;
}

export interface GitCommitOptions {
	pi: ExtensionAPI;
	root: string;
	autoCommit: boolean;
	paths: string[];
	message: string;
	notify?: (msg: string, level?: "info" | "warning" | "error") => void;
}

/**
 * Best-effort auto-commit. Never throws — logs warnings via notify().
 *
 * Detects "nothing to commit" via `git diff --cached --quiet` (exit 0 = no diff)
 * rather than parsing English error messages, so this works in any locale.
 */
export async function gitCommit(opts: GitCommitOptions): Promise<void> {
	if (!opts.autoCommit) return;
	if (opts.paths.length === 0) return;
	try {
		if (!(await isGitRepo(opts.pi, opts.root))) return;

		const add = await opts.pi.exec("git", ["add", "--", ...opts.paths], {
			cwd: opts.root,
			timeout: 5000,
		});
		if (add.code !== 0) {
			opts.notify?.(
				`AI-Knowledge git add failed: ${add.stderr.trim() || `exit ${add.code}`}`,
				"warning",
			);
			return;
		}

		// Skip the commit entirely when nothing is staged for these paths.
		// Exit 0 = no diff, 1 = diff present, anything else = real error.
		const diff = await opts.pi.exec(
			"git",
			["diff", "--cached", "--quiet", "--", ...opts.paths],
			{ cwd: opts.root, timeout: 5000 },
		);
		if (diff.code === 0) return;
		if (diff.code !== 1) {
			opts.notify?.(
				`AI-Knowledge git diff failed: ${diff.stderr.trim() || `exit ${diff.code}`}`,
				"warning",
			);
			return;
		}

		// Pathspec is critical: without it, `git commit` commits the entire
		// index, so any pre-existing staged changes the user had in the vault
		// would piggyback onto the agent's commit. With `-- paths`, only the
		// specified files are committed.
		const commit = await opts.pi.exec(
			"git",
			[
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-m",
				opts.message,
				"--",
				...opts.paths,
			],
			{ cwd: opts.root, timeout: 5000 },
		);
		if (commit.code !== 0) {
			opts.notify?.(
				`AI-Knowledge git commit failed: ${commit.stderr.trim() || `exit ${commit.code}`}`,
				"warning",
			);
		}
	} catch (e) {
		opts.notify?.(
			`AI-Knowledge git error: ${(e as Error).message}`,
			"warning",
		);
	}
}

/** Test/reset hook — clears the in-process repo-detection cache. */
export function _resetGitCache(): void {
	isRepoCache.clear();
}
