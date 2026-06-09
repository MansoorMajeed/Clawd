import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkHardBlock,
	checkBroadGitAdd,
	checkDangerousPattern,
	isPathAllowed,
	checkAccess,
	toolMode,
	extractPaths,
	splitCommands,
	stripQuotedContent,
} from "../extensions/permission-guard/permissions.js";
import {
	buildPermissionScopeOptions,
	isPermissionScopeAllowedForPath,
	normalizePermissionConfig,
	pathForPersistence,
	readOnlyCoverage,
} from "../extensions/permission-guard/index.js";

// ─── Shell Parsing (carried over from dangerous-command-guard) ───

describe("splitCommands", () => {
	it("splits on &&", () => {
		expect(splitCommands("cd foo && make test")).toEqual(["cd foo", "make test"]);
	});

	it("splits on ||", () => {
		expect(splitCommands("test -f foo || echo missing")).toEqual(["test -f foo", "echo missing"]);
	});

	it("splits on ;", () => {
		expect(splitCommands("echo a; echo b")).toEqual(["echo a", "echo b"]);
	});

	it("splits on |", () => {
		expect(splitCommands("ls | grep foo")).toEqual(["ls", "grep foo"]);
	});

	it("respects single quotes", () => {
		expect(splitCommands("echo 'a && b'")).toEqual(["echo 'a && b'"]);
	});

	it("respects double quotes", () => {
		expect(splitCommands('echo "a && b"')).toEqual(['echo "a && b"']);
	});

	it("handles empty input", () => {
		expect(splitCommands("")).toEqual([]);
	});
});

describe("stripQuotedContent", () => {
	it("strips single-quoted strings", () => {
		expect(stripQuotedContent("echo 'rm -rf /'")).toBe("echo ");
	});

	it("strips double-quoted strings", () => {
		expect(stripQuotedContent('echo "rm -rf /"')).toBe("echo ");
	});

	it("strips ANSI-C quoting", () => {
		expect(stripQuotedContent("echo $'rm -rf /'")).toBe("echo ");
	});

	it("leaves unquoted content intact", () => {
		expect(stripQuotedContent("rm -rf /tmp/foo")).toBe("rm -rf /tmp/foo");
	});
});

// ─── Hard Blocks ───

describe("checkHardBlock", () => {
	it("blocks rm -rf .git", () => {
		expect(checkHardBlock("rm -rf .git")).not.toBeNull();
	});

	it("blocks rm -rf .git/", () => {
		expect(checkHardBlock("rm -rf .git/")).not.toBeNull();
	});

	it("blocks rm -r .git", () => {
		expect(checkHardBlock("rm -r .git")).not.toBeNull();
	});

	it("blocks rm -rf / (nuke root)", () => {
		expect(checkHardBlock("rm -rf /")).not.toBeNull();
	});

	it("blocks rm -rf ~ (nuke home)", () => {
		expect(checkHardBlock("rm -rf ~")).not.toBeNull();
	});

	it("blocks rm -rf ~/ (nuke home with slash)", () => {
		expect(checkHardBlock("rm -rf ~/")).not.toBeNull();
	});

	it("blocks find .git -delete", () => {
		expect(checkHardBlock("find .git -delete")).not.toBeNull();
	});

	it("blocks .git deletion inside compound command", () => {
		expect(checkHardBlock("cd /tmp && rm -rf .git")).not.toBeNull();
	});

	it("does NOT block rm -rf .github", () => {
		expect(checkHardBlock("rm -rf .github")).toBeNull();
	});

	it("does NOT block rm of normal directory", () => {
		expect(checkHardBlock("rm -rf node_modules")).toBeNull();
	});

	it("does NOT block .git in quoted string (e.g., echo)", () => {
		expect(checkHardBlock("echo 'rm -rf .git'")).toBeNull();
	});

	it("does NOT block rm -rf /tmp/foo (not root)", () => {
		expect(checkHardBlock("rm -rf /tmp/foo")).toBeNull();
	});
});

// ─── Broad Git Staging ───

describe("checkBroadGitAdd", () => {
	it("blocks broad staging options", () => {
		expect(checkBroadGitAdd("git add -A")).not.toBeNull();
		expect(checkBroadGitAdd("git add --all")).not.toBeNull();
		expect(checkBroadGitAdd("git add -u")).not.toBeNull();
		expect(checkBroadGitAdd("git add --update")).not.toBeNull();
		expect(checkBroadGitAdd("git add -Av")).not.toBeNull();
		expect(checkBroadGitAdd("git add -uv")).not.toBeNull();
	});

	it("blocks broad pathspecs", () => {
		expect(checkBroadGitAdd("git add .")).not.toBeNull();
		expect(checkBroadGitAdd("git add ./")).not.toBeNull();
		expect(checkBroadGitAdd("git add -- .")).not.toBeNull();
		expect(checkBroadGitAdd("git add :/")).not.toBeNull();
	});

	it("blocks broad staging inside compound commands", () => {
		expect(checkBroadGitAdd("git status --short && git add -A && git commit -m 'x'")).not.toBeNull();
	});

	it("blocks broad staging in newline-separated commands", () => {
		expect(checkBroadGitAdd("git status --short\ngit add -A")).not.toBeNull();
	});

	it("recognizes git global options before add", () => {
		expect(checkBroadGitAdd("git -C ../repo add -A")).not.toBeNull();
		expect(checkBroadGitAdd("git -c core.quotePath=false add --all")).not.toBeNull();
	});

	it("blocks equivalent broad pathspecs", () => {
		expect(checkBroadGitAdd("git add './.'")).not.toBeNull();
		expect(checkBroadGitAdd("git add './/'")).not.toBeNull();
		expect(checkBroadGitAdd("git add ':(top)'")).not.toBeNull();
		expect(checkBroadGitAdd("git add ':(top).'")).not.toBeNull();
		expect(checkBroadGitAdd("git add ':(top,literal)'")).not.toBeNull();
	});

	it("recognizes shell prefixes before git", () => {
		expect(checkBroadGitAdd("GIT_OPTIONAL_LOCKS=0 git add -A")).not.toBeNull();
		expect(checkBroadGitAdd("command git add -A")).not.toBeNull();
		expect(checkBroadGitAdd("env git add -A")).not.toBeNull();
		expect(checkBroadGitAdd("env GIT_OPTIONAL_LOCKS=0 git add -A")).not.toBeNull();
	});

	it("allows explicit file staging", () => {
		expect(checkBroadGitAdd("git add src/foo.ts")).toBeNull();
		expect(checkBroadGitAdd("git add -- src/foo.ts tests/bar.ts")).toBeNull();
		expect(checkBroadGitAdd("git add src/")).toBeNull();
		expect(checkBroadGitAdd("git add -N src/foo.ts")).toBeNull();
	});

	it("allows patch-based staging", () => {
		expect(checkBroadGitAdd("git add -p")).toBeNull();
		expect(checkBroadGitAdd("git add -p .")).toBeNull();
		expect(checkBroadGitAdd("git add --patch .")).toBeNull();
	});

	it("ignores quoted command text", () => {
		expect(checkBroadGitAdd("echo 'git add -A'")).toBeNull();
		expect(checkBroadGitAdd('echo "git add ."')).toBeNull();
	});
});

// ─── Dangerous Patterns ───

describe("checkDangerousPattern", () => {
	// Existing patterns from dangerous-command-guard
	it("catches git reset --hard", () => {
		expect(checkDangerousPattern("git reset --hard")).not.toBeNull();
	});

	it("catches git push --force", () => {
		expect(checkDangerousPattern("git push --force origin main")).not.toBeNull();
	});

	it("catches git push -f", () => {
		expect(checkDangerousPattern("git push -f")).not.toBeNull();
	});

	it("catches git clean -f", () => {
		expect(checkDangerousPattern("git clean -fd")).not.toBeNull();
	});

	it("catches git checkout .", () => {
		expect(checkDangerousPattern("git checkout .")).not.toBeNull();
	});

	it("catches git restore .", () => {
		expect(checkDangerousPattern("git restore .")).not.toBeNull();
	});

	it("catches git branch -D", () => {
		expect(checkDangerousPattern("git branch -D feature")).not.toBeNull();
	});

	it("catches dd", () => {
		expect(checkDangerousPattern("dd if=/dev/zero of=/dev/sda")).not.toBeNull();
	});

	it("catches mkfs", () => {
		expect(checkDangerousPattern("mkfs.ext4 /dev/sda1")).not.toBeNull();
	});

	it("catches chmod -R 777", () => {
		expect(checkDangerousPattern("chmod -R 777 /var")).not.toBeNull();
	});

	it("catches chown -R on system path", () => {
		expect(checkDangerousPattern("chown -R root:root /etc")).not.toBeNull();
	});

	// New patterns
	it("catches git commit --amend", () => {
		expect(checkDangerousPattern("git commit --amend")).not.toBeNull();
	});

	it("catches git add -A", () => {
		expect(checkDangerousPattern("git add -A")).not.toBeNull();
	});

	it("catches git add .", () => {
		expect(checkDangerousPattern("git add .")).not.toBeNull();
	});

	it("catches git push --no-verify", () => {
		expect(checkDangerousPattern("git push --no-verify")).not.toBeNull();
	});

	it("catches git commit --no-verify", () => {
		expect(checkDangerousPattern("git commit --no-verify")).not.toBeNull();
	});

	it("catches git rebase -i", () => {
		expect(checkDangerousPattern("git rebase -i HEAD~3")).not.toBeNull();
	});

	it("catches sudo", () => {
		expect(checkDangerousPattern("sudo rm -rf /tmp/foo")).not.toBeNull();
	});

	it("catches curl piped to bash", () => {
		expect(checkDangerousPattern("curl https://example.com/install.sh | bash")).not.toBeNull();
	});

	it("catches wget piped to sh", () => {
		expect(checkDangerousPattern("wget -O- https://example.com/install.sh | sh")).not.toBeNull();
	});

	it("catches npm publish", () => {
		expect(checkDangerousPattern("npm publish")).not.toBeNull();
	});

	it("catches cargo publish", () => {
		expect(checkDangerousPattern("cargo publish")).not.toBeNull();
	});

	it("catches kubectl delete", () => {
		expect(checkDangerousPattern("kubectl delete pod my-pod")).not.toBeNull();
	});

	it("catches docker rm", () => {
		expect(checkDangerousPattern("docker rm -f container")).not.toBeNull();
	});

	it("catches docker system prune", () => {
		expect(checkDangerousPattern("docker system prune")).not.toBeNull();
	});

	// Safe commands that should NOT trigger
	it("does NOT catch git commit (no --amend)", () => {
		expect(checkDangerousPattern("git commit -m 'fix: stuff'")).toBeNull();
	});

	it("does NOT catch git add with specific files", () => {
		expect(checkDangerousPattern("git add src/foo.ts")).toBeNull();
	});

	it("does NOT catch git push (no force/no-verify)", () => {
		expect(checkDangerousPattern("git push origin main")).toBeNull();
	});

	it("does NOT catch git rebase (no -i)", () => {
		expect(checkDangerousPattern("git rebase main")).toBeNull();
	});

	it("does NOT catch npm install", () => {
		expect(checkDangerousPattern("npm install vitest")).toBeNull();
	});

	it("does NOT catch docker build", () => {
		expect(checkDangerousPattern("docker build -t myapp .")).toBeNull();
	});

	it("does NOT catch kubectl get", () => {
		expect(checkDangerousPattern("kubectl get pods")).toBeNull();
	});

	it("does NOT catch dangerous pattern in quotes", () => {
		expect(checkDangerousPattern("echo 'git push --force'")).toBeNull();
	});
});

// ─── Path Checking ───

describe("isPathAllowed", () => {
	const allowed = [
		"/Users/testuser/git/myproject",
		"/Users/testuser/git/other-repo",
		"/Users/testuser/.gitconfig",
		"/Users/testuser/.ssh/config",
	];

	it("allows path within an allowed entry", () => {
		expect(isPathAllowed("/Users/testuser/git/myproject/src/foo.ts", allowed)).toBe(true);
	});

	it("allows path at the allowed entry", () => {
		expect(isPathAllowed("/Users/testuser/git/myproject", allowed)).toBe(true);
	});

	it("allows path in additional directory", () => {
		expect(isPathAllowed("/Users/testuser/git/other-repo/README.md", allowed)).toBe(true);
	});

	it("allows explicitly allowed path", () => {
		expect(isPathAllowed("/Users/testuser/.gitconfig", allowed)).toBe(true);
	});

	it("denies path outside allowed entries", () => {
		expect(isPathAllowed("/Users/testuser/secrets/api-key.txt", allowed)).toBe(false);
	});

	it("denies path that is prefix but not subpath", () => {
		// /Users/testuser/git/myproject-evil should NOT match /Users/testuser/git/myproject
		expect(isPathAllowed("/Users/testuser/git/myproject-evil/foo.ts", allowed)).toBe(false);
	});

	it("denies home directory itself", () => {
		expect(isPathAllowed("/Users/testuser", allowed)).toBe(false);
	});

	it("denies root paths", () => {
		expect(isPathAllowed("/etc/passwd", allowed)).toBe(false);
	});

	it("handles trailing slashes", () => {
		expect(isPathAllowed("/Users/testuser/git/myproject/", allowed)).toBe(true);
	});
});

describe("checkAccess", () => {
	it("allows read but denies write for read-only paths", () => {
		expect(checkAccess("/Users/testuser/notes/api.md", "read", ["/Users/testuser/notes"], [])).toBe(true);
		expect(checkAccess("/Users/testuser/notes/api.md", "write", ["/Users/testuser/notes"], [])).toBe(false);
	});

	it("allows read and write for read-write paths", () => {
		expect(checkAccess("/Users/testuser/project/src/foo.ts", "read", [], ["/Users/testuser/project"])).toBe(true);
		expect(checkAccess("/Users/testuser/project/src/foo.ts", "write", [], ["/Users/testuser/project"])).toBe(true);
	});

	it("denies read and write for paths in neither list", () => {
		expect(checkAccess("/Users/testuser/secrets/api-key.txt", "read", ["/Users/testuser/notes"], ["/Users/testuser/project"])).toBe(false);
		expect(checkAccess("/Users/testuser/secrets/api-key.txt", "write", ["/Users/testuser/notes"], ["/Users/testuser/project"])).toBe(false);
	});

	it("uses path-boundary matching for read and write paths", () => {
		expect(checkAccess("/tmp/foo", "read", ["/tmp/foo"], [])).toBe(true);
		expect(checkAccess("/tmp/foo/bar.txt", "read", ["/tmp/foo"], [])).toBe(true);
		expect(checkAccess("/tmp/foobar", "read", ["/tmp/foo"], [])).toBe(false);
	});
});

describe("toolMode", () => {
	it("maps file tools to access modes", () => {
		expect(toolMode("read")).toBe("read");
		expect(toolMode("write")).toBe("write");
		expect(toolMode("edit")).toBe("write");
	});

	it("returns null for non-file tools", () => {
		expect(toolMode("bash")).toBeNull();
		expect(toolMode("some_mcp_tool")).toBeNull();
	});
});

describe("normalizePermissionConfig", () => {
	it("merges legacy permissions into read-write paths", () => {
		expect(
			normalizePermissionConfig({
				additionalDirectories: ["~/src"],
				allowedPaths: ["~/.gitconfig"],
			}),
		).toEqual({ readPaths: [], readWritePaths: ["~/src", "~/.gitconfig"] });
	});

	it("preserves new permissions while merging legacy permissions", () => {
		expect(
			normalizePermissionConfig({
				readPaths: ["~/notes"],
				readWritePaths: ["~/project"],
				additionalDirectories: ["~/legacy-dir"],
				allowedPaths: ["~/legacy-file"],
			}),
		).toEqual({
			readPaths: ["~/notes"],
			readWritePaths: ["~/project", "~/legacy-dir", "~/legacy-file"],
		});
	});

	it("legacy read-write paths allow both read and write access", () => {
		const normalized = normalizePermissionConfig({
			additionalDirectories: ["/Users/testuser/legacy-dir"],
			allowedPaths: ["/Users/testuser/.gitconfig"],
		});

		expect(
			checkAccess(
				"/Users/testuser/legacy-dir/file.txt",
				"read",
				normalized.readPaths,
				normalized.readWritePaths,
			),
		).toBe(true);
		expect(
			checkAccess(
				"/Users/testuser/legacy-dir/file.txt",
				"write",
				normalized.readPaths,
				normalized.readWritePaths,
			),
		).toBe(true);
		expect(
			checkAccess(
				"/Users/testuser/.gitconfig",
				"write",
				normalized.readPaths,
				normalized.readWritePaths,
			),
		).toBe(true);
	});
});

describe("buildPermissionScopeOptions", () => {
	async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const dir = await mkdtemp(join(tmpdir(), "permission-scope-"));
		try {
			return await fn(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it("puts repo root first for paths inside a git repo", async () => {
		await withTempDir(async (dir) => {
			const repo = join(dir, "org", "repo");
			const src = join(repo, "src");
			const file = join(src, "foo.ts");
			await mkdir(join(repo, ".git"), { recursive: true });
			await mkdir(src, { recursive: true });
			await writeFile(file, "export {};\n");

			const options = await buildPermissionScopeOptions(file, dir, "read");

			expect(options.map((option) => option.kind)).toEqual(["repo", "directory", "exact"]);
			expect(options.map((option) => option.resolvedPath)).toEqual([repo, src, file]);
			expect(options[0]?.label).toBe(`Repo root: ${repo}`);
		});
	});

	it("omits repo root outside a git repo", async () => {
		await withTempDir(async (dir) => {
			const folder = join(dir, "notes");
			const file = join(folder, "api.md");
			await mkdir(folder, { recursive: true });
			await writeFile(file, "# API\n");

			const options = await buildPermissionScopeOptions(file, dir, "read");

			expect(options.map((option) => option.kind)).toEqual(["directory", "exact"]);
			expect(options.map((option) => option.resolvedPath)).toEqual([folder, file]);
		});
	});

	it("detects repo root from nearest existing parent for missing leaf paths", async () => {
		await withTempDir(async (dir) => {
			const repo = join(dir, "repo");
			const missingFile = join(repo, "new", "foo.ts");
			await mkdir(join(repo, ".git"), { recursive: true });

			const options = await buildPermissionScopeOptions(missingFile, dir, "write");

			expect(options.map((option) => option.kind)).toEqual(["repo", "directory", "exact"]);
			expect(options.map((option) => option.resolvedPath)).toEqual([
				repo,
				join(repo, "new"),
				missingFile,
			]);
		});
	});

	it("deduplicates directory and exact options for directory paths", async () => {
		await withTempDir(async (dir) => {
			const folder = join(dir, "notes");
			await mkdir(folder, { recursive: true });

			const options = await buildPermissionScopeOptions(folder, dir, "read");

			expect(options.map((option) => option.kind)).toEqual(["directory"]);
			expect(options.map((option) => option.resolvedPath)).toEqual([folder]);
		});
	});

	it("does not suggest dangerously broad root paths", async () => {
		const options = await buildPermissionScopeOptions("/", "/", "read");

		expect(options).toEqual([]);
	});
});

describe("isPermissionScopeAllowedForPath", () => {
	async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const dir = await mkdtemp(join(tmpdir(), "permission-scope-"));
		try {
			return await fn(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it("allows scopes that cover the requested path", async () => {
		await withTempDir(async (dir) => {
			const repo = join(dir, "repo");
			const file = join(repo, "src", "foo.ts");

			await expect(isPermissionScopeAllowedForPath(repo, file)).resolves.toBe(true);
			await expect(isPermissionScopeAllowedForPath(file, file)).resolves.toBe(true);
		});
	});

	it("rejects unrelated scopes for the requested path", async () => {
		await withTempDir(async (dir) => {
			await expect(
				isPermissionScopeAllowedForPath(join(dir, "allowed"), join(dir, "secrets", "token.txt")),
			).resolves.toBe(false);
		});
	});

	it("rejects real home path when HOME is a symlink", async () => {
		await withTempDir(async (dir) => {
			const previousHome = process.env.HOME;
			const realHome = join(dir, "real-home");
			const linkHome = join(dir, "home-link");
			await mkdir(realHome, { recursive: true });
			try {
				await symlink(realHome, linkHome);
			} catch {
				return;
			}

			process.env.HOME = linkHome;
			try {
				await expect(isPermissionScopeAllowedForPath(realHome, join(realHome, "file.txt"))).resolves.toBe(false);
			} finally {
				process.env.HOME = previousHome;
			}
		});
	});
});

describe("pathForPersistence", () => {
	it("keeps project permissions as raw paths", async () => {
		await expect(pathForPersistence("project", "../shared", "/Users/testuser/project")).resolves.toBe("../shared");
	});

	it("resolves global permissions to absolute paths", async () => {
		await expect(pathForPersistence("global", "../shared", "/Users/testuser/project")).resolves.toBe(
			"/Users/testuser/shared",
		);
	});
});

describe("readOnlyCoverage", () => {
	it("detects read-write parent coverage", () => {
		expect(readOnlyCoverage("/Users/testuser/project/src", [], ["/Users/testuser/project"])).toBe(
			"read-write",
		);
	});

	it("detects read-only parent coverage", () => {
		expect(readOnlyCoverage("/Users/testuser/notes/api", ["/Users/testuser/notes"], [])).toBe("read");
	});

	it("returns null when no existing grant covers the path", () => {
		expect(readOnlyCoverage("/Users/testuser/secrets", ["/Users/testuser/notes"], ["/Users/testuser/project"])).toBeNull();
	});
});

// ─── Path Extraction from Tool Inputs ───

describe("extractPaths", () => {
	it("extracts path from read tool", () => {
		expect(extractPaths("read", { path: "/foo/bar.ts" })).toEqual(["/foo/bar.ts"]);
	});

	it("extracts path from write tool", () => {
		expect(extractPaths("write", { path: "/foo/bar.ts", content: "hello" })).toEqual(["/foo/bar.ts"]);
	});

	it("extracts path from single edit", () => {
		expect(extractPaths("edit", { path: "/foo/bar.ts", oldText: "a", newText: "b" })).toEqual(["/foo/bar.ts"]);
	});

	it("extracts paths from multi edit", () => {
		const input = {
			multi: [
				{ path: "/foo/a.ts", oldText: "a", newText: "b" },
				{ path: "/foo/b.ts", oldText: "c", newText: "d" },
			],
		};
		expect(extractPaths("edit", input)).toEqual(["/foo/a.ts", "/foo/b.ts"]);
	});

	it("extracts paths from patch", () => {
		const patch = `*** Begin Patch
*** /foo/a.ts
- old line
+ new line
*** /foo/b.ts
- another old
+ another new
*** End Patch`;
		expect(extractPaths("edit", { patch })).toEqual(["/foo/a.ts", "/foo/b.ts"]);
	});

	it("returns empty for bash tool", () => {
		expect(extractPaths("bash", { command: "ls" })).toEqual([]);
	});

	it("returns empty for unknown tool", () => {
		expect(extractPaths("some_mcp_tool", { whatever: true })).toEqual([]);
	});

	it("handles edit with no path (patch-only)", () => {
		const patch = `*** Begin Patch
*** /foo/a.ts
- old
+ new
*** End Patch`;
		expect(extractPaths("edit", { patch })).toEqual(["/foo/a.ts"]);
	});

	it("deduplicates paths in multi edit", () => {
		const input = {
			multi: [
				{ path: "/foo/a.ts", oldText: "a", newText: "b" },
				{ path: "/foo/a.ts", oldText: "c", newText: "d" },
			],
		};
		expect(extractPaths("edit", input)).toEqual(["/foo/a.ts"]);
	});
});
