import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function executable(path: string, content: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	chmodSync(path, 0o755);
}

function run(command: string, args: string[], options: Record<string, unknown> = {}) {
	return spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		...options,
	});
}

function writeJsonl(path: string, entries: unknown[]) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

const sessionHeader = {
	type: "session",
	version: 3,
	id: "session-id",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/project",
};

function message(id: string, parentId: string | null, role: string, content: unknown) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-01-01T00:00:0${id.length}.000Z`,
		message: { role, content },
	};
}

describe("cookie dismissal helper", () => {
	function cookieScript() {
		const source = readFileSync(
			join(root, "skills/web-browser/scripts/dismiss-cookies.js"),
			"utf8",
		);
		const match = source.match(
			/(?:export )?const COOKIE_DISMISS_SCRIPT = `([\s\S]*?)`;\n\nconst IFRAME_DISMISS_SCRIPT/,
		);
		expect(match).not.toBeNull();
		return match![1];
	}

	function visibleStyle() {
		return { display: "block", visibility: "visible", opacity: "1", position: "static" };
	}

	it("does not click an unrelated page-wide Accept button near cookie-policy text", () => {
		let clicked = false;
		const unrelatedButton = {
			textContent: "Accept",
			value: "",
			offsetParent: {},
			click: () => { clicked = true; },
		};
		const document = {
			body: { textContent: "Read our cookie policy. You have a pending invitation." },
			querySelector: () => null,
			querySelectorAll: (selector: string) =>
				selector === "button, [role=\"button\"]" ? [unrelatedButton] : [],
		};
		const dismiss = new Function(
			"document",
			"window",
			"getComputedStyle",
			`return (${cookieScript()})(true);`,
		);

		expect(dismiss(document, {}, visibleStyle)).toEqual([]);
		expect(clicked).toBe(false);
	});

	it("does not click an unrelated action in ordinary cookie-related content", () => {
		let clicked = false;
		const unrelatedButton = {
			textContent: "Accept all",
			value: "",
			offsetParent: {},
			click: () => { clicked = true; },
		};
		const article = {
			tagName: "DIV",
			offsetParent: {},
			textContent: `${"Browser cookies can remember preferences and analytics choices. ".repeat(3)}Join our mailing list below.`,
			querySelectorAll: () => [unrelatedButton],
		};
		const document = {
			querySelector: () => null,
			querySelectorAll: (selector: string) =>
				selector === 'div, section, aside, [class*="modal"], [class*="dialog"], [role="dialog"]'
					? [article]
					: [],
		};
		const dismiss = new Function(
			"document",
			"window",
			"getComputedStyle",
			`return (${cookieScript()})(true);`,
		);

		expect(dismiss(document, {}, visibleStyle)).toEqual([]);
		expect(clicked).toBe(false);
	});

	it("still clicks a consent action inside an identified cookie banner", () => {
		let clicked = false;
		const button = {
			textContent: "Accept all",
			value: "",
			offsetParent: {},
			click: () => { clicked = true; },
		};
		const container = {
			tagName: "DIV",
			offsetParent: {},
			querySelectorAll: () => [button],
		};
		const document = {
			body: { textContent: "" },
			querySelector: () => null,
			querySelectorAll: (selector: string) =>
				selector === '[class*="cookie-banner"]' ? [container] : [],
		};
		const dismiss = new Function(
			"document",
			"window",
			"getComputedStyle",
			`return (${cookieScript()})(true);`,
		);

		expect(dismiss(document, {}, visibleStyle)).toEqual([
			'Generic ([class*="cookie-banner"])',
		]);
		expect(clicked).toBe(true);
	});
});

describe("librarian checkout helper", () => {
	function fixture() {
		const dir = mkdtempSync(join(tmpdir(), "librarian-test-"));
		const bin = join(dir, "bin");
		const log = join(dir, "git.log");
		executable(join(bin, "git"), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$GIT_LOG"
if [[ "\${1-}" == "clone" ]]; then
  url="\${3-}"
  target="\${4-}"
  mkdir -p "$target/.git"
  printf '%s\\n' "$url" > "$target/.git/mock-origin"
  exit 0
fi
if [[ "\${1-}" == "-C" ]]; then
  checkout="$2"
  shift 2
  case "$1 $2 \${3-}" in
    "remote get-url origin") cat "$checkout/.git/mock-origin" ;;
    "remote add origin") printf '%s\\n' "$4" > "$checkout/.git/mock-origin" ;;
    "remote set-url origin") printf '%s\\n' "$4" > "$checkout/.git/mock-origin" ;;
    "symbolic-ref --short -q") printf 'main\\n' ;;
    "rev-parse --abbrev-ref --symbolic-full-name") printf 'origin/main\\n' ;;
    "status --porcelain --untracked-files=no") : ;;
    *) : ;;
  esac
fi
`);
		return {
			dir,
			log,
			cache: join(dir, "cache"),
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				GIT_LOG: log,
				LIBRARIAN_CACHE_ROOT: join(dir, "cache"),
			},
		};
	}

	it.each(["invalid", "https://example.com/../../outside"])(
		"rejects %s before invoking git",
		(repo) => {
			const f = fixture();
			const result = run("bash", ["skills/librarian/checkout.sh", repo], { env: f.env });

			expect(result.status).not.toBe(0);
			expect(() => readFileSync(f.log, "utf8")).toThrow();
		},
	);

	it("rejects a checkout path redirected outside the cache by a symlink", () => {
		const f = fixture();
		const outside = join(f.dir, "outside");
		mkdirSync(f.cache, { recursive: true });
		mkdirSync(outside);
		symlinkSync(outside, join(f.cache, "github.com"));

		const result = run(
			"bash",
			["skills/librarian/checkout.sh", "github.com/org/repo"],
			{ env: f.env },
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("escapes cache root");
		expect(() => readFileSync(f.log, "utf8")).toThrow();
	});

	it("preserves SSH transport for clone and an existing origin", () => {
		const f = fixture();
		const clone = run(
			"bash",
			["skills/librarian/checkout.sh", "git@github.com:org/repo.git"],
			{ env: f.env },
		);
		expect(clone.status, clone.stderr).toBe(0);
		expect(readFileSync(f.log, "utf8")).toContain(
			"clone --filter=blob:none git@github.com:org/repo.git",
		);

		writeFileSync(join(f.cache, "github.com/org/repo/.git/mock-origin"), "https://github.com/org/repo.git\n");
		writeFileSync(f.log, "");
		const existing = run(
			"bash",
			["skills/librarian/checkout.sh", "git@github.com:org/repo.git"],
			{ env: f.env },
		);

		expect(existing.status, existing.stderr).toBe(0);
		expect(readFileSync(f.log, "utf8")).toContain(
			"remote set-url origin git@github.com:org/repo.git",
		);
		expect(readFileSync(join(f.cache, "github.com/org/repo/.git/mock-origin"), "utf8").trim()).toBe(
			"git@github.com:org/repo.git",
		);
	});
});

describe("Pi session extraction", () => {
	const extractor = "skills/improve-skill/scripts/extract-session.js";

	it("prefers PI_SESSION_FILE over unrelated agent sessions", () => {
		const dir = mkdtempSync(join(tmpdir(), "extract-session-current-"));
		const project = join(dir, "project");
		mkdirSync(project);
		const currentPi = join(dir, "current.jsonl");
		writeJsonl(currentPi, [sessionHeader, message("pi", null, "user", "current pi")]);

		const claudeDir = join(dir, ".claude", "projects", project.replace(/\//g, "-"));
		const claude = join(claudeDir, "newer.jsonl");
		writeJsonl(claude, [message("cl", null, "user", "wrong claude")]);
		const future = new Date(Date.now() + 60_000);
		utimesSync(claude, future, future);

		const result = run("node", [join(root, extractor)], {
			cwd: project,
			env: { ...process.env, HOME: dir, PI_SESSION_FILE: currentPi },
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Agent: pi");
		expect(result.stdout).toContain("Selection: current PI_SESSION_FILE");
		expect(result.stdout).toContain("current pi");
		expect(result.stdout).not.toContain("wrong claude");
	});

	it("prefers an explicit --cwd over PI_SESSION_FILE", () => {
		const dir = mkdtempSync(join(tmpdir(), "extract-session-cwd-"));
		const targetProject = join(dir, "target-project");
		mkdirSync(targetProject);
		const currentPi = join(dir, "current.jsonl");
		writeJsonl(currentPi, [sessionHeader, message("current", null, "user", "current session")]);

		const encodedTarget = `--${targetProject.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;
		const targetPi = join(dir, ".pi", "agent", "sessions", encodedTarget, "target.jsonl");
		writeJsonl(targetPi, [sessionHeader, message("target", null, "user", "target cwd session")]);

		const result = run("node", [join(root, extractor), "--cwd", targetProject], {
			env: { ...process.env, HOME: dir, PI_SESSION_FILE: currentPi },
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Selection: newest fallback for cwd");
		expect(result.stdout).toContain("target cwd session");
		expect(result.stdout).not.toContain("current session");
	});

	it("extracts only the active Pi branch and preserves summaries and tool calls", () => {
		const dir = mkdtempSync(join(tmpdir(), "extract-session-branch-"));
		const session = join(dir, "session.jsonl");
		writeJsonl(session, [
			sessionHeader,
			message("a", null, "user", "root request"),
			message("b", "a", "assistant", [
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			]),
			message("c", "b", "user", "abandoned branch message"),
			{
				type: "branch_summary",
				id: "d",
				parentId: "b",
				timestamp: "2026-01-01T00:00:04.000Z",
				fromId: "c",
				summary: "Abandoned branch learned an important constraint.",
			},
			message("e", "d", "user", "current branch message"),
			{
				type: "compaction",
				id: "f",
				parentId: "e",
				timestamp: "2026-01-01T00:00:06.000Z",
				summary: "Compacted context summary.",
				tokensBefore: 100,
			},
		]);

		const result = run("node", [extractor, "--agent", "pi", session]);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Agent: pi");
		expect(result.stdout).toContain("[Tool: read]");
		expect(result.stdout).toContain('"path": "README.md"');
		expect(result.stdout).toContain("Abandoned branch learned an important constraint.");
		expect(result.stdout).toContain("Compacted context summary.");
		expect(result.stdout).toContain("current branch message");
		expect(result.stdout).not.toContain("abandoned branch message");
	});

	it("selects the newest fallback across agents and labels the fallback", () => {
		const dir = mkdtempSync(join(tmpdir(), "extract-session-fallback-"));
		const project = join(dir, "project");
		mkdirSync(project);
		const encodedClaude = project.replace(/\//g, "-");
		const encodedPi = `--${project.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;
		const claude = join(dir, ".claude", "projects", encodedClaude, "old.jsonl");
		const pi = join(dir, ".pi", "agent", "sessions", encodedPi, "new.jsonl");
		writeJsonl(claude, [message("cl", null, "user", "older claude")]);
		writeJsonl(pi, [sessionHeader, message("pi", null, "user", "newer pi")]);
		const old = new Date(Date.now() - 60_000);
		const now = new Date();
		utimesSync(claude, old, old);
		utimesSync(pi, now, now);

		const result = run("node", [join(root, extractor)], {
			cwd: project,
			env: { ...process.env, HOME: dir, PI_SESSION_FILE: "" },
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Agent: pi");
		expect(result.stdout).toContain("Selection: newest fallback for cwd");
		expect(result.stdout).toContain("newer pi");
	});

	it("is directly executable", () => {
		expect(statSync(join(root, extractor)).mode & 0o111).not.toBe(0);
	});
});

describe("tmux completion waiting", () => {
	it.each(["bash", "zsh"])("documented completion recipe emits statuses under %s", (shell) => {
		const skill = readFileSync(join(root, "skills/tmux/SKILL.md"), "utf8");
		const assignments = [...skill.matchAll(/; ([a-zA-Z_][a-zA-Z0-9_]*)=\\\$\?; printf/g)]
			.map((match) => match[1]);
		expect(assignments).toHaveLength(2);

		for (const statusVariable of assignments) {
			for (const [command, expectedStatus] of [["true", 0], ["false", 1]] as const) {
				const marker = `recipe-${shell}-${command}`;
				const recipe = `${command}; ${statusVariable}=$?; printf '\\n%s:%s\\n' '${marker}' "$${statusVariable}"`;
				const result = run(shell, ["-c", recipe]);

				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout.trim()).toBe(`${marker}:${expectedStatus}`);
			}
		}
	});

	function runWait(paneText: string, marker: string) {
		const dir = mkdtempSync(join(tmpdir(), "tmux-wait-"));
		executable(join(dir, "tmux"), `#!/usr/bin/env bash
printf '%s\\n' "$PANE_TEXT"
`);
		return run(
			"bash",
			[
				"skills/tmux/scripts/wait-for-text.sh",
				"--target", "work:0.0",
				"--completion-marker", marker,
				"--timeout", "0",
			],
			{ env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PANE_TEXT: paneText } },
		);
	}

	it("does not accept an echoed command or an old marker", () => {
		const result = runWait(
			'shell$ long-command; printf "\\n%s:%s\\n" "new-marker" "$?"\nold-marker:0',
			"new-marker",
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Timed out");
	});

	it("accepts only a complete marker line and checks success status", () => {
		expect(runWait("output\nmarker-1:0", "marker-1").status).toBe(0);
		const failed = runWait("output\nmarker-2:7", "marker-2");
		expect(failed.status).toBe(1);
		expect(failed.stderr).toContain("completed with status 7");
	});
});

describe("summarize helper", () => {
	it("streams long Markdown to Pi stdin instead of an argv argument", () => {
		const dir = mkdtempSync(join(tmpdir(), "summarize-long-"));
		const bin = join(dir, "bin");
		const input = join(dir, "input.txt");
		const argsFile = join(dir, "pi-args");
		const stdinFile = join(dir, "pi-stdin");
		writeFileSync(input, "source");
		executable(join(bin, "uvx"), `#!/usr/bin/env bash
head -c 140000 /dev/zero | tr '\\0' x
`);
		executable(join(bin, "pi"), `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$PI_ARGS_FILE"
cat > "$PI_STDIN_FILE"
printf 'summary output'
`);

		const result = run(
			"node",
			["skills/summarize/to-markdown.mjs", input, "--summary"],
			{
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					PI_ARGS_FILE: argsFile,
					PI_STDIN_FILE: stdinFile,
				},
				timeout: 10_000,
			},
		);

		expect(result.status, result.stderr).toBe(0);
		const piArgs = readFileSync(argsFile).toString().split("\0").filter(Boolean);
		expect(Math.max(...piArgs.map((arg) => arg.length))).toBeLessThan(10_000);
		expect(piArgs).toEqual(expect.arrayContaining([
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
		]));
		expect(readFileSync(stdinFile, "utf8").length).toBeGreaterThan(130_000);
		expect(result.stdout).toContain("summary output");
	});
});

describe("Mermaid validation helper", () => {
	it("reports a render/validation failure without classifying it as bad syntax", () => {
		const dir = mkdtempSync(join(tmpdir(), "mermaid-validate-"));
		const input = join(dir, "diagram.mmd");
		writeFileSync(input, "flowchart LR\nA-->B\n");
		executable(join(dir, "npx"), `#!/usr/bin/env bash
echo 'npm unavailable' >&2
exit 42
`);

		const result = run("bash", ["skills/mermaid/tools/validate.sh", input], {
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("npm unavailable");
		expect(result.stdout).toContain("Mermaid render/validation failed; inspect the error above");
		expect(result.stdout.toLowerCase()).not.toContain("invalid syntax");
	});
});
